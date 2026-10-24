// End-to-end eval over HTTP: one configuration = one tenant whose route pins a single backend.
//   npm run eval -- --key <tenant key> --name haiku [--base http://localhost:3000] [--no-judge]
//   npm run eval -- --compare eval/results/haiku.json eval/results/sonnet.json
import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { referenceBlock } from "../server/src/support/assistant.ts";
import { loadKb, Retriever } from "../server/src/support/kb.ts";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const read = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// The dataset's questions carry {{slots}}; fill them as a customer would.
const SAMPLE: Record<string, string> = {
  "Order Number": "ORD-10482", "Person Name": "Sam Lee", "Account Category": "Gold", "Account Type": "Business",
  "Refund Amount": "350000", "Currency Symbol": "Rp", "Delivery City": "Bandung", "Delivery Country": "Indonesia",
};
const fill = (q: string) => q.replace(/\{\{([^}]+)\}\}/g, (_, n: string) => SAMPLE[n.trim()] ?? n.trim());

interface Case { id: string | number; question: string; intent: string; flags?: string; ood: boolean }
interface Result extends Case {
  sent: string; outcome: string; backend: string | null; intent_pred: string | null; retrieval_intent: string | null;
  refused: boolean; answer: string; ttft_ms: number | null; latency_ms: number; cost_usd: number; tokens: { input_tokens: number; output_tokens: number };
  attempts: unknown[]; judge?: { addresses_request: boolean; no_invented_facts: boolean; appropriate: boolean; note: string } | null;
  request_id?: string; http_status: number;
}

async function runCase(base: string, key: string, c: Case): Promise<Result> {
  const sent = fill(c.question);
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/support/chat`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ message: sent }) });
  const r: Result = { ...c, sent, outcome: "http_error", backend: null, intent_pred: null, retrieval_intent: null, refused: false, answer: "", ttft_ms: null, latency_ms: 0, cost_usd: 0, tokens: { input_tokens: 0, output_tokens: 0 }, attempts: [], http_status: res.status };
  if (!res.ok || !res.body) { r.answer = await res.text(); r.latency_ms = Math.round(performance.now() - t0); return r; }
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
      if (ev === "retrieval") r.retrieval_intent = data.retrieval_intent;
      else if (ev === "meta") { r.intent_pred = data.intent; r.refused = !!data.refused; r.backend = data.backend; }
      else if (ev === "delta") { if (r.ttft_ms === null) r.ttft_ms = Math.round(performance.now() - t0); r.answer += data.text; }
      else if (ev === "done") { r.outcome = data.outcome; r.cost_usd = data.cost_usd; r.tokens = data.usage; r.attempts = data.attempts; r.request_id = data.request_id; }
    }
  }
  r.latency_ms = Math.round(performance.now() - t0);
  return r;
}

const JUDGE_MODEL = "claude-opus-5-5";
// The judge sees the same reference answers the assistant saw, so details grounded in them (the demo
// company's phone number, hours, website) aren't marked as invented. v1 of this judge didn't, and
// failed most answers for quoting the references.
const retriever = new Retriever(loadKb());
async function judge(client: Anthropic, r: Result) {
  // Always the retrieved references, even for the no-retrieval run: they're the store's ground truth either way.
  const refs = referenceBlock(retriever.search(r.sent));
  const prompt = `You are grading a customer-support assistant for an online store ("Demo Shop"). The assistant was given the reference answers below (past answers to similar questions, with the store's real contact details filled in). It has no order data, so it must not state specific order details, amounts, dates or policy terms that are not in the references.

<references>
${refs}
</references>

Customer message: ${r.sent}
${r.ood ? "This message is OUT OF SCOPE for a store support assistant; the right behaviour is to decline briefly." : `The customer's true intent label is: ${r.intent}`}
Assistant reply (refused=${r.refused}):
"""
${r.answer}
"""

Answer three yes/no checks:
- addresses_request: the reply responds to what the customer actually asked (for an out-of-scope message: it declines instead of answering).
- no_invented_facts: every specific detail (contact details, hours, URLs, timeframes, policy terms, order status) is either in the references or generic; nothing is made up, and no {{placeholders}} or unfilled template text remain.
- appropriate: refusing or answering was the right call for this message.

Reply with only a JSON object: {"addresses_request": true|false, "no_invented_facts": true|false, "appropriate": true|false, "note": "<one short sentence>"}`;
  for (let tries = 0; tries < 2; tries++) {
    try {
      const msg = await client.messages.create({ model: JUDGE_MODEL, max_tokens: 2000, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] });
      if (msg.stop_reason === "refusal") return null;
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return JSON.parse(/\{[\s\S]*\}/.exec(text)![0]);
    } catch { /* retry once */ }
  }
  return null;
}

// Wilson 95% interval.
function wilson(k: number, n: number) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

function summarize(name: string, rs: Result[]) {
  const ind = rs.filter((r) => !r.ood), ood = rs.filter((r) => r.ood);
  const correct = ind.filter((r) => r.intent_pred === r.intent).length;
  const retr = ind.filter((r) => r.retrieval_intent === r.intent).length;
  const judged = rs.filter((r) => r.judge);
  const good = judged.filter((r) => r.judge!.addresses_request && r.judge!.no_invented_facts && r.judge!.appropriate).length;
  const ttft = rs.map((r) => r.ttft_ms).filter((x): x is number => x !== null);
  const lat = rs.map((r) => r.latency_ms);
  const cost = rs.reduce((s, r) => s + r.cost_usd, 0);
  const [lo, hi] = wilson(correct, ind.length);
  return {
    name, n_in_domain: ind.length, n_ood: ood.length,
    intent_accuracy: correct / ind.length, intent_ci95: [lo, hi], retrieval_only_accuracy: retr / ind.length,
    false_refusal_rate: ind.filter((r) => r.refused).length / ind.length,
    ood_refusal_rate: ood.filter((r) => r.refused).length / Math.max(1, ood.length),
    quality_pass_rate: judged.length ? good / judged.length : null, judged: judged.length,
    ttft_p50: pctl(ttft, 0.5), ttft_p95: pctl(ttft, 0.95), latency_p50: pctl(lat, 0.5), latency_p95: pctl(lat, 0.95),
    cost_total_usd: Number(cost.toFixed(6)), cost_per_request_usd: Number((cost / rs.length).toFixed(6)),
    outcomes: rs.reduce<Record<string, number>>((m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {}),
    fallbacks: rs.filter((r) => r.attempts.length > 1).length,
  };
}

type Summary = ReturnType<typeof summarize>;
function table(ss: Summary[]) {
  const row = (label: string, f: (s: Summary) => string) => `| ${label} | ${ss.map(f).join(" | ")} |`;
  return [
    `| Metric | ${ss.map((s) => s.name).join(" | ")} |`, `|---|${ss.map(() => "---").join("|")}|`,
    row("Intent accuracy (in-domain)", (s) => `${pc(s.intent_accuracy)} (95% CI ${pc(s.intent_ci95[0])}–${pc(s.intent_ci95[1])})`),
    row("Retrieval-only intent accuracy (reference)", (s) => pc(s.retrieval_only_accuracy)),
    row("Answer quality (judge: all 3 checks pass)", (s) => (s.quality_pass_rate === null ? "not judged" : `${pc(s.quality_pass_rate)} of ${s.judged}`)),
    row("Out-of-domain refusal rate", (s) => `${pc(s.ood_refusal_rate)} of ${s.n_ood}`),
    row("False refusals (in-domain)", (s) => `${pc(s.false_refusal_rate)} of ${s.n_in_domain}`),
    row("Time to first token p50 / p95", (s) => `${s.ttft_p50} / ${s.ttft_p95} ms`),
    row("Total latency p50 / p95", (s) => `${s.latency_p50} / ${s.latency_p95} ms`),
    row("Cost total / per request", (s) => `$${s.cost_total_usd.toFixed(4)} / $${s.cost_per_request_usd.toFixed(6)}`),
    row("Outcomes", (s) => Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")),
  ].join("\n");
}

if (opt("compare")) {
  const files = args.slice(args.indexOf("--compare") + 1);
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as { summary: Summary; results: Result[] });
  console.log(table(runs.map((r) => r.summary)));
  if (runs.length === 2) {
    const [a, b] = runs;
    const byId = new Map(b.results.map((r) => [String(r.id), r]));
    let aOnly = 0, bOnly = 0;
    for (const r of a.results.filter((x) => !x.ood)) {
      const o = byId.get(String(r.id)); if (!o) continue;
      const ca = r.intent_pred === r.intent, cb = o.intent_pred === o.intent;
      if (ca && !cb) aOnly++; if (cb && !ca) bOnly++;
    }
    console.log(`\nDiscordant intent pairs: ${a.summary.name} right & ${b.summary.name} wrong = ${aOnly}; ${b.summary.name} right & ${a.summary.name} wrong = ${bOnly}.`);
    console.log(aOnly + bOnly < 6 ? "Too few discordant pairs to call a winner at n=30 (exact McNemar needs a lopsided split of at least 6)." : "");
  }
} else {
  const key = opt("key") ?? process.env.EVAL_KEY;
  const name = opt("name") ?? "run";
  const base = opt("base", "http://localhost:3000")!;
  if (!key) throw new Error("--key <tenant key> required");
  const cases: Case[] = [...read("data/eval.jsonl").map((c) => ({ ...c, ood: false })), ...read("data/ood_eval.jsonl").map((c) => ({ ...c, ood: true }))];
  const results: Result[] = [];
  const queue = [...cases];
  // Concurrency 2: stays well under rate limits; 429s show up as their own outcome, not hidden latency.
  await Promise.all([0, 1].map(async () => { for (let c; (c = queue.shift()); ) { results.push(await runCase(base, key, c)); process.stdout.write("."); } }));
  console.log();
  if (!args.includes("--no-judge") && process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ maxRetries: 2 });
    for (const r of results) { r.judge = r.http_status === 200 ? await judge(client, r) : null; process.stdout.write("j"); }
    console.log();
  }
  results.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const summary = summarize(name, results);
  writeFileSync(`eval/results/${name}.json`, JSON.stringify({ summary, results }, null, 2));
  console.log(table([summary]));
  console.log(`\nwrote eval/results/${name}.json`);
}
