import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { CHAT_MAX_TOKENS, costMicros, env } from "../config.ts";
import { pool } from "../db/pool.ts";
import { bearer, isAdmin, tenantForKey, type DemoTenant, type Tenant } from "../gateway/auth.ts";
import { execute, type Gate, type RunResult } from "../gateway/executor.ts";
import { finishRequest, recentRequests, recordRejected, startRequest, totals, usageFor } from "../gateway/metering.ts";
import { remainingMicros } from "../gateway/quota.ts";
import { Sse } from "../gateway/sse.ts";
import { breaker } from "../gateway/breaker.ts";
import { buildRequest, commitDecision, confidenceFor, intentGate, OOD_THRESHOLD, REFUSAL_TEXT } from "../support/assistant.ts";
import type { Retriever } from "../support/kb.ts";
import { slotFilter } from "../support/slots.ts";

const SupportBody = z.object({ message: z.string().trim().min(1).max(2000) });
const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) })).min(1).max(20)
    .refine((m) => m[0].role === "user", "first message must be from the user")
    .refine((m) => m[m.length - 1].role === "user", "last message must be from the user"),
  max_tokens: z.number().int().min(1).max(CHAT_MAX_TOKENS).optional(),
});

const usd = (m: number) => Number((m / 1e6).toFixed(6));

// The raw chat route has no header: commit on the first text.
const passGate: Gate = { feed: (buffer, ended) => (buffer.length > 0 ? { kind: "ok", rest: buffer } : ended ? { kind: "bad", reason: "empty output" } : { kind: "pending" }) };
const passFilter = () => ({ changed: false, push: (t: string) => t, flush: () => "" });

export function buildApp(retriever: Retriever, demoKeys: DemoTenant[] = []) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 64 * 1024 });

  async function authTenant(req: FastifyRequest, reply: FastifyReply): Promise<Tenant | null> {
    let t: Tenant | null;
    try {
      t = await tenantForKey(bearer(req.headers.authorization));
    } catch (e) {
      req.log.error(e, "auth lookup failed");
      reply.code(503).send({ error: "unavailable", message: "Database unreachable; refusing to serve without quota checks." });
      return null;
    }
    if (!t) reply.code(401).send({ error: "unauthorized", message: "Missing, unknown or revoked API key." });
    return t;
  }

  // Fail closed: the tenant's first-choice backend must fit before the stream starts. Checking the
  // cheapest one instead let an exhausted tenant keep getting free mock answers. Each attempt
  // still reserves atomically, so concurrent requests can't overspend.
  async function quotaPrecheck(t: Tenant, estChars: number, maxTokens: number, reply: FastifyReply, id: string, endpoint: string) {
    const firstCost = costMicros(t.route[0].backend, Math.ceil(estChars / 3), maxTokens);
    let rem: number;
    try {
      rem = await remainingMicros(t.id);
    } catch {
      reply.code(503).send({ error: "unavailable" });
      return false;
    }
    if (rem < firstCost || rem <= 0) {
      await recordRejected(id, t.id, endpoint, "quota_exceeded", "precheck").catch(() => {});
      reply.code(429).send({ error: "quota_exceeded", message: "Tenant quota cannot cover this request.", remaining_usd: usd(Math.max(0, rem)) });
      return false;
    }
    return true;
  }

  function clientAbort(req: FastifyRequest, reply: FastifyReply) {
    const ctl = new AbortController();
    reply.raw.on("close", () => { if (!reply.raw.writableFinished) ctl.abort(); });
    return ctl.signal;
  }

  // After the stream has opened, a database failure can't become an HTTP status; end the stream
  // with an error instead of leaving it hanging. The request row stays in_flight and its
  // reservation is released at the next boot.
  async function safeExecute(sse: Sse, opts: Parameters<typeof execute>[0], log: FastifyRequest["log"]): Promise<RunResult> {
    try {
      return await execute(opts);
    } catch (e) {
      log.error(e, "request failed after stream start");
      sse.send("error", { code: "internal_error", message: "The gateway failed while serving this request." });
      return { outcome: "failed", attempts: [], error: "internal_error", sanitized: false };
    }
  }

  function done(sse: Sse, id: string, r: RunResult, latency: number) {
    const t = totals(r.attempts);
    sse.send("done", {
      request_id: id, outcome: r.outcome, backend: r.backend ?? null, model: r.model ?? null,
      usage: { input_tokens: t.input_tokens, output_tokens: t.output_tokens, estimated: t.estimated },
      cost_usd: usd(t.cost_micros), latency_ms: latency, ttft_ms: r.ttft_ms ?? null,
      attempts: r.attempts.map((a) => ({ backend: a.backend, outcome: a.outcome, ttft_ms: a.ttft_ms ?? null, latency_ms: a.latency_ms ?? null, error: a.error ?? null, cost_usd: usd(a.cost_micros) })),
    });
  }

  app.post("/v1/support/chat", async (req, reply) => {
    const t0 = Date.now();
    const body = SupportBody.safeParse(req.body);
    const tenant = await authTenant(req, reply);
    if (!tenant) return reply;
    if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

    const id = randomUUID();
    const message = body.data.message;
    const retrieval = retriever.search(message);
    const useRetrieval = env.supportRetrieval;
    const probe = buildRequest(message, retrieval, useRetrieval);
    if (!(await quotaPrecheck(tenant, probe.system!.length + probe.messages[0].content.length, probe.maxTokens, reply, id, "support"))) return reply;
    try {
      await startRequest(id, tenant.id, "support");
    } catch {
      return reply.code(503).send({ error: "unavailable" });
    }

    const sse = new Sse(reply.raw);
    reply.hijack();
    sse.open();
    sse.send("retrieval", {
      request_id: id,
      entries: retrieval.entries.map(({ id, intent, question, score }) => ({ id, intent, question, score })),
      retrieval_intent: retrieval.majority, votes: retrieval.votes, top_score: retrieval.topScore,
    });

    let result: RunResult;
    if (useRetrieval && (!retrieval.majority || retrieval.topScore < OOD_THRESHOLD)) {
      sse.send("meta", { request_id: id, intent: null, confidence: null, backend: null, model: null, refused: true, refusal_reason: "no close match in the knowledge base" });
      sse.send("delta", { text: REFUSAL_TEXT });
      result = { outcome: "refused_low_confidence", attempts: [], sanitized: false };
    } else {
      result = await safeExecute(sse, {
        requestId: id, tenantId: tenant.id, route: tenant.route,
        build: () => probe,
        gate: intentGate,
        onCommit: (b, intent) => commitDecision(b, id, intent, retrieval, useRetrieval),
        filter: slotFilter(),
        sse, clientSignal: clientAbort(req, reply),
      }, req.log);
    }
    const latency = Date.now() - t0;
    const conf = useRetrieval && result.intent && result.intent !== "out_of_scope" ? confidenceFor(result.intent, retrieval).score : undefined;
    await finishRequest(id, result, latency, conf).catch((e) => req.log.error(e, "metering write failed"));
    done(sse, id, result, latency);
    sse.end();
  });

  app.post("/v1/chat", async (req, reply) => {
    const t0 = Date.now();
    const body = ChatBody.safeParse(req.body);
    const tenant = await authTenant(req, reply);
    if (!tenant) return reply;
    if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

    const id = randomUUID();
    const breq = { messages: body.data.messages, maxTokens: body.data.max_tokens ?? CHAT_MAX_TOKENS };
    const chars = breq.messages.reduce((n, m) => n + m.content.length, 0);
    if (!(await quotaPrecheck(tenant, chars, breq.maxTokens, reply, id, "chat"))) return reply;
    try {
      await startRequest(id, tenant.id, "chat");
    } catch {
      return reply.code(503).send({ error: "unavailable" });
    }
    const sse = new Sse(reply.raw);
    reply.hijack();
    sse.open();
    const result = await safeExecute(sse, {
      requestId: id, tenantId: tenant.id, route: tenant.route,
      build: () => breq,
      gate: passGate,
      onCommit: (b) => ({ kind: "stream", meta: { request_id: id, backend: b.id, model: b.model, intent: null, confidence: null, refused: false, refusal_reason: null } }),
      filter: passFilter(),
      sse, clientSignal: clientAbort(req, reply),
    }, req.log);
    const latency = Date.now() - t0;
    await finishRequest(id, result, latency).catch((e) => req.log.error(e, "metering write failed"));
    done(sse, id, result, latency);
    sse.end();
  });

  app.get("/v1/usage", async (req, reply) => {
    const tenant = await authTenant(req, reply);
    if (!tenant) return reply;
    return { tenant: (await usageFor(tenant.id))[0] };
  });

  const canReadUsage = (auth: string | undefined) => env.demoMode || isAdmin(auth);

  app.get("/demo", async () => (env.demoMode ? { enabled: true, tenants: demoKeys } : { enabled: false, tenants: [] }));

  app.get("/admin/usage", async (req, reply) => {
    if (!canReadUsage(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    return { tenants: await usageFor(), breakers: breaker.snapshot() };
  });

  app.get("/admin/requests", async (req, reply) => {
    if (!canReadUsage(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const q = z.object({ tenant: z.string().min(1), limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_request", issues: q.error.issues });
    return { requests: await recentRequests(q.data.tenant, q.data.limit) };
  });

  app.get("/healthz", async () => {
    await pool.query("select 1");
    return { ok: true };
  });

  const dist = fileURLToPath(new URL("../../../web/dist", import.meta.url));
  if (existsSync(dist)) {
    app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !/^\/(v1|admin|demo)\b/.test(req.url)
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: "not_found" }),
    );
  }

  // Malformed JSON and oversized bodies come back as the same 400 shape.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error(err);
    reply.code(status).send({ error: status === 500 ? "internal_error" : "invalid_request", message: err.message });
  });

  return app;
}
