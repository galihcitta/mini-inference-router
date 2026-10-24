// Throwaway fake of the router API for console development. Not the real server.
// Run: node dev/fake-server.mjs  (port 3000). Key "bad" -> 401, "quota" -> 429.
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

const attempts = [
  { seq: 1, backend: "haiku", outcome: "timeout", ttft_ms: null, latency_ms: 52, error: "first token timeout (50 ms)" },
  { seq: 2, backend: "sonnet", outcome: "ok", ttft_ms: 610, latency_ms: 1840, error: null },
];

async function streamChat(req, res, support) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "invalid_request", issues: ["body is not JSON"] });
  }
  const key = bearer(req);
  if (!key || key === "bad") return json(res, 401, { error: "unauthorized" });
  if (key === "quota") return json(res, 429, { error: "quota_exceeded", remaining_usd: 0.000123 });
  if (key === "down") return json(res, 503, { error: "unavailable" });
  const msg = support ? body.message : body.messages?.[0]?.content;
  if (typeof msg !== "string" || !msg) {
    return json(res, 400, { error: "invalid_request", issues: [support ? "message: required" : "messages: required"] });
  }

  const id = randomUUID();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let closed = false;
  res.on("close", () => (closed = true));
  const send = (event, data) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (support) {
    send("retrieval", {
      request_id: id,
      entries: [
        { id: 101, intent: "cancel_order", question: "how do I cancel my order", score: 12.4 },
        { id: 102, intent: "cancel_order", question: "i want to cancel an order", score: 11.9 },
        { id: 103, intent: "cancel_order", question: "cancel purchase", score: 9.7 },
        { id: 204, intent: "track_order", question: "where is my order", score: 6.1 },
        { id: 105, intent: "cancel_order", question: "help cancelling order", score: 5.8 },
      ],
      retrieval_intent: "cancel_order",
      votes: { cancel_order: 4, track_order: 1 },
    });
  }
  await sleep(300);
  send("meta", {
    request_id: id,
    intent: support ? "cancel_order" : null,
    confidence: support ? { score: 0.8, level: "high", votes: 4, agrees: true } : null,
    backend: "sonnet",
    model: "claude-sonnet-5-5",
    refused: false,
    refusal_reason: null,
  });
  const answer =
    "To cancel your order, open Orders, select the order and choose Cancel. " +
    "If it has already shipped, you can start a return instead. Multi-byte check: café ✓.";
  // Write deltas in small raw pieces so events are split across TCP chunks.
  for (let i = 0; i < answer.length && !closed; i += 8) {
    const frame = `event: delta\ndata: ${JSON.stringify({ text: answer.slice(i, i + 8) })}\n\n`;
    const cut = Math.floor(frame.length / 2);
    res.write(frame.slice(0, cut));
    await sleep(15);
    if (!closed) res.write(frame.slice(cut));
    await sleep(25);
  }
  send("done", {
    request_id: id,
    outcome: "ok",
    backend: "sonnet",
    usage: { input_tokens: 1123, output_tokens: 41, estimated: false },
    cost_usd: 0.003984,
    latency_ms: 1892,
    ttft_ms: 662,
    attempts,
  });
  res.end();
}

const tenants = [
  { id: "acme", name: "Acme", requests: 42, cost_usd: 0.081234, quota_usd: 5, used_usd: 0.081234, remaining_usd: 4.918766 },
  { id: "slow-haiku", name: "Slow Haiku", requests: 7, cost_usd: 0.02811, quota_usd: 5, used_usd: 0.02811, remaining_usd: 4.97189 },
  { id: "tiny", name: "Tiny", requests: 3, cost_usd: 0.00098, quota_usd: 0.001, used_usd: 0.00098, remaining_usd: 0.00002 },
];

function requestsFor(tenant) {
  return [
    {
      id: randomUUID(), created_at: new Date().toISOString(), endpoint: "/v1/support/chat", outcome: "ok",
      backend: "sonnet", model: "claude-sonnet-5-5", intent: "cancel_order", confidence: 0.8,
      input_tokens: 1123, output_tokens: 41, usage_estimated: false, cost_usd: 0.003984,
      ttft_ms: 662, latency_ms: 1892, fallback: true, attempts,
    },
    {
      id: randomUUID(), created_at: new Date(Date.now() - 60000).toISOString(), endpoint: "/v1/support/chat",
      outcome: "refused_low_confidence", backend: null, model: null, intent: null, confidence: null,
      input_tokens: 0, output_tokens: 0, usage_estimated: false, cost_usd: 0, ttft_ms: null, latency_ms: 9,
      fallback: false, attempts: [],
    },
    {
      id: randomUUID(), created_at: new Date(Date.now() - 120000).toISOString(), endpoint: "/v1/chat", outcome: "ok",
      backend: tenant === "tiny" ? "mock" : "haiku", model: "claude-haiku-5-5", intent: null, confidence: null,
      input_tokens: 20, output_tokens: 12, usage_estimated: true, cost_usd: 0.000076, ttft_ms: 300, latency_ms: 520,
      fallback: false, attempts: [{ seq: 1, backend: "haiku", outcome: "ok", ttft_ms: 300, latency_ms: 520, error: null }],
    },
  ];
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/v1/support/chat") return streamChat(req, res, true);
    if (req.method === "POST" && url.pathname === "/v1/chat") return streamChat(req, res, false);
    if (url.pathname.startsWith("/admin/")) {
      if (!bearer(req) || bearer(req) === "bad") return json(res, 401, { error: "unauthorized" });
      if (url.pathname === "/admin/usage") return json(res, 200, { tenants });
      if (url.pathname === "/admin/requests") {
        const t = url.searchParams.get("tenant");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return json(res, 200, { requests: requestsFor(t).slice(0, limit) });
      }
    }
    json(res, 404, { error: "not_found" });
  })
  .listen(PORT, () => console.log(`fake server on http://localhost:${PORT}`));
