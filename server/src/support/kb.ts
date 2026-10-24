import { readFileSync } from "node:fs";
import MiniSearch from "minisearch";

export interface KbEntry { id: number; question: string; answer: string; intent: string; category: string }

export const INTENTS = [
  "cancel_order", "change_order", "change_shipping_address", "check_cancellation_fee", "check_invoice",
  "check_payment_methods", "check_refund_policy", "complaint", "contact_customer_service", "contact_human_agent",
  "create_account", "delete_account", "delivery_options", "delivery_period", "edit_account", "get_invoice",
  "get_refund", "newsletter_subscription", "payment_issue", "place_order", "recover_password",
  "registration_problems", "review", "set_up_shipping_address", "switch_account", "track_order", "track_refund",
] as const;
export const INTENT_SET = new Set<string>(INTENTS);

const stripSlots = (s: string) => s.replace(/\{\{[^}]+\}\}/g, " ");

// Function words dominate these short questions ("i dont know what i need to..."); dropping them
// raised dev intent accuracy from 86.5% to 90.6% and separates out-of-domain questions (scripts/tune.ts).
const STOP = new Set(
  "i me my we our you your it is am are was be been to the a an of in on for and or but do does did can could would should will with at from this that how what want need know dont don't not have has had im i'm please help get any some there".split(" "),
);

export function loadKb(path = new URL("../../../data/kb.jsonl", import.meta.url)): KbEntry[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

export interface Retrieval {
  entries: { id: number; intent: string; question: string; answer: string; score: number }[];
  votes: Record<string, number>;
  majority: string | null;
  topScore: number;
}

export class Retriever {
  private index: MiniSearch<KbEntry>;
  private byId: Map<number, KbEntry>;

  constructor(kb: KbEntry[]) {
    this.byId = new Map(kb.map((e) => [e.id, e]));
    this.index = new MiniSearch<KbEntry>({
      fields: ["question"],
      // Also used for the id field, so only rewrite the question.
      extractField: (doc, field) => (field === "question" ? stripSlots(doc.question) : (doc as unknown as Record<string, never>)[field]),
      processTerm: (t) => {
        const w = t.toLowerCase();
        return STOP.has(w) ? null : w;
      },
      searchOptions: { prefix: true },
    });
    this.index.addAll(kb);
  }

  search(query: string, k = 5): Retrieval {
    const hits = this.index.search(stripSlots(query)).slice(0, k);
    const entries = hits.map((h) => {
      const e = this.byId.get(h.id as number)!;
      return { id: e.id, intent: e.intent, question: e.question, answer: e.answer, score: Number(h.score.toFixed(3)) };
    });
    const votes: Record<string, number> = {};
    const weight: Record<string, number> = {};
    for (const e of entries) {
      votes[e.intent] = (votes[e.intent] ?? 0) + 1;
      weight[e.intent] = (weight[e.intent] ?? 0) + e.score;
    }
    // Score-weighted vote: two strong matches beat three weak ones.
    const majority = Object.keys(weight).sort((a, b) => weight[b] - weight[a])[0] ?? null;
    return { entries, votes, majority, topScore: entries[0]?.score ?? 0 };
  }
}
