import { costMicros, TIMEOUTS, type BackendId, type RouteEntry } from "../config.ts";
import { backends } from "../backends/registry.ts";
import type { Backend, BackendRequest } from "../backends/types.ts";
import { breaker } from "./breaker.ts";
import { classify } from "./classify.ts";
import { reserve, settle } from "./quota.ts";
import type { Sse } from "./sse.ts";

export type AttemptOutcome =
  | "ok" | "timeout_first_token" | "timeout_total" | "rate_limited" | "provider_error" | "account_error"
  | "bad_request" | "unusable_output" | "skipped_quota" | "skipped_account" | "circuit_open"
  | "refused_by_model" | "partial" | "client_aborted";

export interface Attempt {
  seq: number;
  backend: BackendId;
  outcome: AttemptOutcome;
  ttft_ms?: number;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  usage_estimated?: boolean;
  cost_micros: number;
  error?: string;
}

// Decides when buffered model text may be committed to the client. Fallback is only possible
// before commit, because sent tokens can't be taken back.
export type GateResult = { kind: "pending" } | { kind: "ok"; rest: string; intent?: string } | { kind: "bad"; reason: string };
export interface Gate { feed(buffer: string, ended: boolean): GateResult }

export type CommitDecision =
  | { kind: "stream"; meta: Record<string, unknown> }
  | { kind: "refuse"; meta: Record<string, unknown>; text: string; outcome: string };

export interface TextFilter { push(t: string): string; flush(): string; changed: boolean }

export interface RunOptions {
  requestId: string;
  tenantId: string;
  route: RouteEntry[];
  build(backend: BackendId): BackendRequest;
  gate: Gate;
  onCommit(backend: Backend, intent?: string): CommitDecision;
  filter: TextFilter;
  sse: Sse;
  clientSignal: AbortSignal;
}

export interface RunResult {
  outcome: string;
  backend?: BackendId;
  model?: string;
  intent?: string;
  meta?: Record<string, unknown>;
  attempts: Attempt[];
  ttft_ms?: number;
  error?: string;
  sanitized: boolean;
}

const FAILURES_COUNTED: AttemptOutcome[] = ["timeout_first_token", "timeout_total", "rate_limited", "provider_error", "unusable_output", "bad_request"];
const hasOverrides = (e: RouteEntry) =>
  e.first_token_ms !== undefined || e.total_ms !== undefined || e.fail_rate !== undefined || e.latency_ms !== undefined;

export async function execute(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const attempts: Attempt[] = [];
  let accountDown = false;

  for (const entry of o.route) {
    const id = entry.backend;
    const backend = backends[id];
    const seq = attempts.length + 1;
    if (!backend) continue;
    if (accountDown && id !== "mock") {
      attempts.push({ seq, backend: id, outcome: "skipped_account", cost_micros: 0 });
      continue;
    }
    if (!breaker.allows(id)) {
      attempts.push({ seq, backend: id, outcome: "circuit_open", cost_micros: 0 });
      continue;
    }
    const req = o.build(id);
    const estIn = Math.ceil(((req.system ?? "") + req.messages.map((m) => m.content).join("")).length / 3);
    const reserved = costMicros(id, estIn, req.maxTokens);
    if (reserved > 0 && !(await reserve(o.tenantId, o.requestId, reserved))) {
      attempts.push({ seq, backend: id, outcome: "skipped_quota", cost_micros: 0 });
      continue;
    }

    const a = await attempt(o, backend, entry, req, seq, started);
    attempts.push(a.attempt);
    await settle(o.tenantId, o.requestId, reserved, a.attempt.cost_micros);

    const out = a.attempt.outcome;
    if (out === "account_error") {
      accountDown = true;
      breaker.trip("haiku");
      breaker.trip("sonnet");
    } else if (FAILURES_COUNTED.includes(out)) {
      if (!hasOverrides(entry)) breaker.failure(id); // demo tenants' forced timeouts don't poison shared state
    } else if (out === "ok") {
      breaker.success(id);
    }

    if (a.result) return { ...a.result, attempts, sanitized: o.filter.changed };
  }

  const quota = attempts.length > 0 && attempts.every((x) => x.outcome === "skipped_quota" || x.outcome === "circuit_open" || x.outcome === "skipped_account")
    && attempts.some((x) => x.outcome === "skipped_quota");
  const code = quota ? "quota_exceeded" : "all_backends_failed";
  o.sse.send("error", { code, message: quota ? "Quota cannot cover this request on any allowed backend." : "Every allowed backend failed." });
  return { outcome: quota ? "quota_exceeded" : "failed", attempts, error: code, sanitized: false };
}

async function attempt(o: RunOptions, backend: Backend, entry: RouteEntry, req: BackendRequest, seq: number, requestStart: number) {
  const t0 = Date.now();
  const limits = { ...TIMEOUTS[backend.id], ...pick(entry) };
  const ctl = new AbortController();
  let abortWhy: AttemptOutcome | "discard" | undefined;
  const abort = (why: AttemptOutcome | "discard") => { abortWhy ??= why; ctl.abort(); };
  const ftTimer = setTimeout(() => abort("timeout_first_token"), limits.first_token_ms);
  const totTimer = setTimeout(() => abort("timeout_total"), limits.total_ms);
  const signal = AbortSignal.any([o.clientSignal, ctl.signal]);

  let input: number | undefined, output: number | undefined, estimated = false;
  let stop: string | undefined, firstAt: number | undefined, chars = 0;
  let buffer = "";
  let committed = false;
  let result: Omit<RunResult, "attempts" | "sanitized"> | undefined;
  let outcome: AttemptOutcome = "ok";
  let error: string | undefined;

  const forward = (text: string) => {
    const safe = o.filter.push(text);
    if (safe) o.sse.send("delta", { text: safe });
  };
  const commit = (rest: string, intent?: string): boolean => {
    const d = o.onCommit(backend, intent);
    const ttft = Date.now() - requestStart;
    o.sse.send("meta", d.meta);
    if (d.kind === "refuse") {
      o.sse.send("delta", { text: d.text });
      result = { outcome: d.outcome, backend: backend.id, model: backend.model, intent, meta: d.meta, ttft_ms: ttft };
      return false;
    }
    committed = true;
    result = { outcome: "ok", backend: backend.id, model: backend.model, intent, meta: d.meta, ttft_ms: ttft };
    forward(rest);
    return true;
  };

  try {
    for await (const c of backend.stream(req, entry, signal)) {
      if (c.type === "usage") {
        if (c.input !== undefined) input = c.input;
        if (c.output !== undefined) output = c.output;
        if (c.estimated) estimated = true;
      } else if (c.type === "stop") {
        stop = c.reason;
      } else {
        if (firstAt === undefined) { firstAt = Date.now(); clearTimeout(ftTimer); }
        chars += c.text.length;
        if (committed) { forward(c.text); continue; }
        buffer += c.text;
        const g = o.gate.feed(buffer, false);
        if (g.kind === "bad") { outcome = "unusable_output"; error = g.reason; abort("discard"); break; }
        if (g.kind === "ok" && !commit(g.rest, g.intent)) { abort("discard"); break; }
      }
    }
    if (!committed && !result && outcome === "ok") {
      if (stop === "refusal") {
        outcome = "refused_by_model";
        result = { outcome: "refused_by_model", backend: backend.id, model: backend.model };
        o.sse.send("meta", { backend: backend.id, model: backend.model, refused: true, refusal_reason: "model_refusal" });
        o.sse.send("delta", { text: "Sorry, I can't help with that request." });
      } else {
        const g = o.gate.feed(buffer, true);
        if (g.kind === "ok") commit(g.rest, g.intent);
        else {
          outcome = "unusable_output";
          error = stop === "max_tokens" ? "max_tokens before any answer" : g.kind === "bad" ? g.reason : "empty output";
        }
      }
    } else if (committed) {
      const tail = o.filter.flush();
      if (tail) o.sse.send("delta", { text: tail });
      if (stop === "refusal") result!.outcome = "refused_by_model";
      else if (stop === "max_tokens") error = "truncated at max_tokens";
    }
  } catch (err) {
    if (o.clientSignal.aborted) outcome = "client_aborted";
    else if (abortWhy === "timeout_first_token" || abortWhy === "timeout_total") outcome = abortWhy;
    else if (abortWhy !== "discard") {
      const c = classify(err);
      outcome = c.outcome;
      error = c.detail;
    }
    if (committed) {
      if (outcome !== "client_aborted") {
        o.sse.send("error", { code: outcome, message: "The backend failed after the answer started; the answer is incomplete." });
        outcome = "partial";
      }
      result!.outcome = outcome === "client_aborted" ? "client_aborted" : "partial";
      result!.error = error ?? outcome;
    } else if (outcome === "client_aborted") {
      result = { outcome: "client_aborted" };
    }
  } finally {
    clearTimeout(ftTimer);
    clearTimeout(totTimer);
  }

  // Usage the provider reported; otherwise estimate what we saw (characters / 4).
  if (output === undefined && chars > 0) { output = Math.ceil(chars / 4); estimated = true; }
  const cost = costMicros(backend.id, input ?? 0, output ?? 0);
  const a: Attempt = {
    seq, backend: backend.id, outcome,
    ttft_ms: firstAt !== undefined ? firstAt - t0 : undefined,
    latency_ms: Date.now() - t0,
    input_tokens: input, output_tokens: output, usage_estimated: estimated,
    cost_micros: cost, error,
  };
  return { attempt: a, result };
}

function pick(e: RouteEntry) {
  const r: { first_token_ms?: number; total_ms?: number } = {};
  if (e.first_token_ms !== undefined) r.first_token_ms = e.first_token_ms;
  if (e.total_ms !== undefined) r.total_ms = e.total_ms;
  return r;
}
