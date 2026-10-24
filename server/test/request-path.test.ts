import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouteEntry } from "../src/config.ts";
import { migrate, pool } from "../src/db/pool.ts";
import { hashKey, newApiKey } from "../src/gateway/auth.ts";
import { breaker } from "../src/gateway/breaker.ts";
import { setBackend } from "../src/backends/registry.ts";
import { BackendFailure, type Backend, type Chunk } from "../src/backends/types.ts";
import { buildApp } from "../src/http/app.ts";
import { startRequest } from "../src/gateway/metering.ts";
import { reserve } from "../src/gateway/quota.ts";
import { loadKb, Retriever } from "../src/support/kb.ts";

const app = buildApp(new Retriever(loadKb()));
const Q = "I want to cancel my order, how do I do that?";

type Script = (signal: AbortSignal) => AsyncGenerator<Chunk>;
const calls: string[] = [];
function scripted(id: "haiku" | "sonnet", script: Script): void {
  const b: Backend = { id, model: `test-${id}`, stream: (_r, _e, signal) => { calls.push(id); return script(signal); } };
  setBackend(b);
}
async function* answer(intent: string, text: string, usage = { input: 1000, output: 50 }): AsyncGenerator<Chunk> {
  yield { type: "usage", input: usage.input };
  yield { type: "text", text: `<intent>${intent}</intent>\n` };
  for (const w of text.split(" ")) yield { type: "text", text: w + " " };
  yield { type: "usage", output: usage.output };
  yield { type: "stop", reason: "end_turn" };
}
async function* hang(signal: AbortSignal): AsyncGenerator<Chunk> {
  await sleep(10_000, undefined, { signal });
}

async function tenant(id: string, route: RouteEntry[], quotaMicros = 1_000_000): Promise<string> {
  await pool.query(`insert into tenants (id, name, quota_micros, route) values ($1, $1, $2, $3)`, [id, quotaMicros, JSON.stringify(route)]);
  const key = newApiKey();
  await pool.query(`insert into api_keys (tenant_id, key_hash, prefix) values ($1, $2, 'mir_')`, [id, hashKey(key)]);
  return key;
}
async function post(key: string, message = Q, path = "/v1/support/chat") {
  const res = await app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${key}` }, payload: path === "/v1/chat" ? { messages: [{ role: "user", content: message }] } : { message } });
  const events = res.headers["content-type"]?.toString().startsWith("text/event-stream")
    ? res.payload.trim().split("\n\n").map((b) => {
        const [e, d] = b.split("\n");
        return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
      })
    : [];
  const done = events.find((e) => e.event === "done")?.data;
  const text = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
  return { res, events, done, text };
}
const H: RouteEntry = { backend: "haiku" }, S: RouteEntry = { backend: "sonnet" }, M: RouteEntry = { backend: "mock", latency_ms: 0 };

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await pool.query("truncate request_attempts, requests, api_keys, tenants cascade");
  breaker.reset();
  calls.length = 0;
  scripted("haiku", () => answer("cancel_order", "You can cancel from the Orders page."));
  scripted("sonnet", () => answer("cancel_order", "Sonnet answer here."));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("auth", () => {
  it("rejects missing, unknown and revoked keys with 401 and writes no request row", async () => {
    const key = await tenant("t1", [H]);
    await pool.query("update api_keys set revoked_at = now()");
    for (const k of ["", "mir_unknown", key]) expect((await post(k)).res.statusCode).toBe(401);
    expect((await pool.query("select count(*)::int n from requests")).rows[0].n).toBe(0);
  });
});

describe("input validation", () => {
  it("returns 400 with field issues for an empty or oversized message and malformed JSON", async () => {
    const key = await tenant("t1", [H]);
    expect((await post(key, "")).res.statusCode).toBe(400);
    expect((await post(key, "x".repeat(2001))).res.json().issues[0].path).toBe("message");
    const bad = await app.inject({ method: "POST", url: "/v1/support/chat", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("quota", () => {
  it("fails closed with 429 and remaining_usd when the quota can't cover a request", async () => {
    const key = await tenant("t1", [H], 100);
    const { res } = await post(key);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "quota_exceeded", remaining_usd: 0.0001 });
    expect(calls).toEqual([]);
  });
  it("reservations are atomic: 25 concurrent reserves of 100 against a 1,000 quota admit exactly 10", async () => {
    await tenant("t1", [H], 1000);
    const ids = Array.from({ length: 25 }, () => crypto.randomUUID());
    for (const id of ids) await startRequest(id, "t1", "support");
    const ok = (await Promise.all(ids.map((id) => reserve("t1", id, 100)))).filter(Boolean).length;
    expect(ok).toBe(10);
    expect((await pool.query("select used_micros from tenants")).rows[0].used_micros).toBe(1000);
  });
});

describe("routing and fallback", () => {
  it("falls back to Sonnet on a first-token timeout and records the trail", async () => {
    scripted("haiku", hang);
    const key = await tenant("t1", [{ backend: "haiku", first_token_ms: 50 }, S, M]);
    const { done, events, text } = await post(key);
    expect(done.backend).toBe("sonnet");
    expect(done.attempts.map((a: { backend: string; outcome: string }) => [a.backend, a.outcome])).toEqual([["haiku", "timeout_first_token"], ["sonnet", "ok"]]);
    expect(events.map((e) => e.event).slice(0, 2)).toEqual(["retrieval", "meta"]);
    expect(text).toContain("Sonnet answer");
    const row = (await pool.query("select outcome, backend, fallback from requests")).rows[0];
    expect(row).toEqual({ outcome: "ok", backend: "sonnet", fallback: true });
    const attempts = (await pool.query("select backend, outcome from request_attempts order by seq")).rows;
    expect(attempts).toEqual([{ backend: "haiku", outcome: "timeout_first_token" }, { backend: "sonnet", outcome: "ok" }]);
  });

  it("skips every Anthropic backend after an account error and serves from the mock", async () => {
    scripted("haiku", async function* () { throw new BackendFailure("invalid x-api-key", 401); });
    const key = await tenant("t1", [H, S, M]);
    const { done } = await post(key);
    expect(done.attempts.map((a: { outcome: string }) => a.outcome)).toEqual(["account_error", "skipped_account", "ok"]);
    expect(done.backend).toBe("mock");
    expect(calls).toEqual(["haiku"]);
  });

  it("treats a reply without the intent header as unusable and falls back", async () => {
    scripted("haiku", async function* () { yield { type: "text", text: "Sure! Here is how you cancel..." }; });
    const key = await tenant("t1", [H, S]);
    const { done } = await post(key);
    expect(done.attempts[0]).toMatchObject({ backend: "haiku", outcome: "unusable_output" });
    expect(done.backend).toBe("sonnet");
  });

  it("does not fall back when the model refuses", async () => {
    scripted("haiku", async function* () { yield { type: "usage", input: 900 }; yield { type: "stop", reason: "refusal" }; });
    const key = await tenant("t1", [H, S, M]);
    const { done } = await post(key);
    expect(done.outcome).toBe("refused_by_model");
    expect(calls).toEqual(["haiku"]);
  });

  it("ends with an error event and outcome partial when the backend dies mid-answer", async () => {
    scripted("haiku", async function* () {
      yield { type: "usage", input: 1000 };
      yield { type: "text", text: "<intent>cancel_order</intent>\nYou can cancel " };
      throw new BackendFailure("connection reset", 503);
    });
    const key = await tenant("t1", [H, S]);
    const { done, events } = await post(key);
    expect(events.some((e) => e.event === "error")).toBe(true);
    expect(done.outcome).toBe("partial");
    expect(calls).toEqual(["haiku"]);
  });

  it("opens the circuit after repeated failures, but not for routes with timeout overrides", async () => {
    scripted("haiku", async function* () { throw new BackendFailure("overloaded", 529); });
    const key = await tenant("t1", [H, S]);
    for (let i = 0; i < 3; i++) await post(key);
    const { done } = await post(key);
    expect(done.attempts[0].outcome).toBe("circuit_open");
    breaker.reset();
    scripted("haiku", hang);
    const k2 = await tenant("t2", [{ backend: "haiku", first_token_ms: 20 }, S]);
    for (let i = 0; i < 4; i++) await post(k2);
    expect(breaker.allows("haiku")).toBe(true);
  });
});

describe("support assistant", () => {
  it("refuses an out-of-domain question before calling any model", async () => {
    const key = await tenant("t1", [H]);
    const { done, events } = await post(key, "explain how black holes form");
    expect(done.outcome).toBe("refused_low_confidence");
    expect(events.find((e) => e.event === "meta")!.data.refused).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses when the model labels the message out_of_scope", async () => {
    scripted("haiku", () => answer("out_of_scope", ""));
    const key = await tenant("t1", [H]);
    expect((await post(key)).done.outcome).toBe("refused_out_of_scope");
  });

  it("fills placeholders the model leaks mid-stream", async () => {
    scripted("haiku", () => answer("cancel_order", "Visit {{Website URL}} to cancel."));
    const key = await tenant("t1", [H]);
    const { text } = await post(key);
    expect(text).toContain("demo-shop.example");
    expect(text).not.toContain("{{");
    expect((await pool.query("select sanitized from requests")).rows[0].sanitized).toBe(true);
  });
});

describe("metering", () => {
  it("records provider-reported tokens and cost on the request row, matching the done event", async () => {
    const key = await tenant("t1", [H]);
    const { done } = await post(key);
    expect(done.usage).toEqual({ input_tokens: 1000, output_tokens: 50, estimated: false });
    expect(done.cost_usd).toBeCloseTo((1000 * 0.1 + 50 * 0.5) / 1e6, 9);
    const row = (await pool.query("select input_tokens, output_tokens, cost_micros, reserved_micros, latency_ms from requests")).rows[0];
    expect(row).toMatchObject({ input_tokens: 1000, output_tokens: 50, cost_micros: 125, reserved_micros: 0 });
    expect((await pool.query("select used_micros from tenants")).rows[0].used_micros).toBe(125);
  });

  it("streams the raw chat endpoint through the same gateway", async () => {
    scripted("haiku", async function* () { yield { type: "usage", input: 10 }; yield { type: "text", text: "hello" }; yield { type: "usage", output: 2 }; yield { type: "stop", reason: "end_turn" }; });
    const key = await tenant("t1", [H]);
    const { done, text } = await post(key, "hi", "/v1/chat");
    expect(text).toBe("hello");
    expect(done).toMatchObject({ outcome: "ok", backend: "haiku" });
  });
});
