import type { BackendRequest } from "../backends/types.ts";
import type { CommitDecision, Gate } from "../gateway/executor.ts";
import { SUPPORT_MAX_TOKENS } from "../config.ts";
import { INTENTS, INTENT_SET, type Retrieval } from "./kb.ts";
import { fillSlots } from "./slots.ts";

// Below this top BM25 score, nothing in the KB is close enough to answer from: refuse before
// any model call. Tuned on data/dev.jsonl + data/ood_dev.jsonl (scripts/tune.ts): 0.3% false refusals, 4/5 OOD caught. Never tuned on the eval set.
export const OOD_THRESHOLD = Number(process.env.OOD_THRESHOLD ?? 4);

export const REFUSAL_TEXT =
  "I'm not confident I can answer that correctly. I can help with orders, shipping, refunds, invoices, payments and your account. Could you rephrase, or would you like to contact a human agent?";
export const OUT_OF_SCOPE_TEXT =
  "I can only help with Demo Shop orders, shipping, refunds, invoices, payments and accounts.";

export const SYSTEM_PROMPT = `You are the customer support assistant for Demo Shop, an online store.

Reply format, always:
1. First, exactly one line: <intent>LABEL</intent>
   LABEL is the customer's intent, one of: ${INTENTS.join(", ")}.
   Use out_of_scope if the message is not a customer-support request for an online store.
2. Then the answer to the customer, in plain text, under 120 words.

Rules for the answer:
- Base it on the reference answers provided with the message. They are past answers to similar questions; adapt them to this customer's wording.
- Do not invent order details, prices, dates, policies, phone numbers or links that aren't in the references.
- Do not use placeholders in curly braces.
- If the label is out_of_scope, write nothing after the intent line.`;

// The no-retrieval ablation: same format and rules, minus the references.
export const SYSTEM_PROMPT_NO_REFS = SYSTEM_PROMPT
  .replace(/- Base it on the reference answers[^\n]*\n/, "")
  .replace(" that aren't in the references", "");

export function referenceBlock(r: Retrieval): string {
  return r.entries
    .map((e, i) => `<reference n="${i + 1}" intent="${e.intent}">\nQ: ${fillSlots(e.question)}\nA: ${fillSlots(e.answer)}\n</reference>`)
    .join("\n");
}

export function buildRequest(message: string, r: Retrieval, withReferences = true): BackendRequest {
  const top = r.entries[0];
  const customer = `<customer_message>\n${message}\n</customer_message>`;
  return {
    system: withReferences ? SYSTEM_PROMPT : SYSTEM_PROMPT_NO_REFS,
    messages: [{ role: "user", content: withReferences ? `${referenceBlock(r)}\n\n${customer}` : customer }],
    maxTokens: SUPPORT_MAX_TOKENS,
    mockReply: top ? `<intent>${r.majority}</intent>\n${fillSlots(top.answer)}` : undefined,
  };
}

// The model must open with <intent>label</intent>; nothing is sent to the client until it does.
export const intentGate: Gate = {
  feed(buffer, ended) {
    const s = buffer.trimStart();
    const m = /^<intent>\s*([a-z_]+)\s*<\/intent>/.exec(s);
    if (m) {
      const label = m[1];
      if (label !== "out_of_scope" && !INTENT_SET.has(label)) return { kind: "bad", reason: `unknown intent label "${label}"` };
      return { kind: "ok", intent: label, rest: s.slice(m[0].length).replace(/^\s*\n/, "") };
    }
    if (!"<intent>".startsWith(s.slice(0, 8)) ) return { kind: "bad", reason: "reply did not start with <intent>" };
    if (s.length > 80 || ended) return { kind: "bad", reason: "no closing </intent> within 80 characters" };
    return { kind: "pending" };
  },
};

export function confidenceFor(intent: string, r: Retrieval) {
  const votes = r.votes[intent] ?? 0;
  const score = votes / 5;
  const level = score >= 0.8 ? "high" : score >= 0.4 ? "medium" : "low";
  return { score, level, votes, agrees: intent === r.majority };
}

export function commitDecision(backend: { id: string; model: string }, requestId: string, intent: string | undefined, r: Retrieval, useRetrieval = true): CommitDecision {
  const base = { request_id: requestId, backend: backend.id, model: backend.model };
  if (!intent || intent === "out_of_scope") {
    return {
      kind: "refuse", outcome: "refused_out_of_scope", text: OUT_OF_SCOPE_TEXT,
      meta: { ...base, intent: "out_of_scope", confidence: null, refused: true, refusal_reason: "out_of_scope" },
    };
  }
  if (!useRetrieval) return { kind: "stream", meta: { ...base, intent, confidence: null, refused: false, refusal_reason: null } };
  const confidence = confidenceFor(intent, r);
  if (confidence.level === "low") {
    return {
      kind: "refuse", outcome: "refused_low_confidence", text: REFUSAL_TEXT,
      meta: { ...base, intent, confidence, refused: true, refusal_reason: "model intent not supported by retrieval" },
    };
  }
  return { kind: "stream", meta: { ...base, intent, confidence, refused: false, refusal_reason: null } };
}
