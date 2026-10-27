// Shot list and narration for the demo video. Each shot proves one or more of the challenge's
// assessment areas (docs/mini-inference-router-challenge.md, "What We Assess").
// `setup` plays as the shot opens; `payoff` plays once the shot's result is on screen.

export type Area = "Request path" | "Routing and fallback" | "Measurement" | "Exception handling" | "Judgement";

export interface Expect {
  tenant: string;
  outcome?: string;          // requests.outcome in Postgres
  backend?: string | null;   // requests.backend
  attempts?: string[];       // backend:outcome per attempt, in order
  http?: number;             // for requests rejected before a row with a request id exists in the UI
}

export interface Shot {
  id: string;
  title: string;
  areas: Area[];
  kind: "card" | "scenario" | "auth" | "usage";
  scenario?: string;         // scenario button title in the console
  verdict?: RegExp;          // text the verdict must show before the payoff plays
  highlights?: (string | null)[]; // ring per payoff sentence, in order; null keeps the previous one
  card?: { heading: string; lines: string[] };
  setup: string;
  payoff?: string;
  expect?: Expect[];
}

export const LIVE_URL = "https://mini-inference-router.onrender.com";

export const SHOTS: Shot[] = [
  {
    id: "intro", title: "Title", areas: ["Judgement"], kind: "card",
    card: {
      heading: "Mini Inference Router",
      lines: [
        "An LLM gateway with a customer-support assistant on top",
        "Per-tenant keys · cost budgets · Haiku → Sonnet → backup · every attempt recorded",
        "Live at mini-inference-router.onrender.com",
      ],
    },
    setup:
      "This is the Mini Inference Router, running live on Render. It's a small L L M gateway with a customer support assistant on top. " +
      "Every request is authenticated per tenant, checked against a dollar budget, routed to Haiku first, then Sonnet, then a backup, and recorded. " +
      "What this video shows: it behaves correctly when things fail, and you can see why.",
  },
  {
    id: "normal", title: "A normal question", areas: ["Request path", "Measurement"], kind: "scenario",
    scenario: "A normal question",
    verdict: /Haiku 5\.5 answered on the first try/,
    highlights: [".verdict", ".stats", null, ".evidence"],
    setup:
      "This is the live console. On the left are scenarios, and each one uses a demo tenant with its own key and route. " +
      "First, a normal question from tenant acme.",
    payoff:
      "Haiku answered on the first try, streamed to the browser as it was written. " +
      "Before any text reached the screen, the model had to state the intent in a header, and the gateway checked it: cancel order. " +
      "Below are the tokens, the time to first token, the total time, and the cost, a fraction of a cent. " +
      "On the right are the closest past questions from the knowledge base, and the intent each one carries.",
    expect: [{ tenant: "acme", outcome: "ok", backend: "haiku", attempts: ["haiku:ok"] }],
  },
  {
    id: "offtopic", title: "Clearly off-topic", areas: ["Exception handling", "Judgement"], kind: "scenario",
    scenario: "Clearly off-topic",
    verdict: /Refused without calling a model/,
    highlights: [".verdict", ".inspect"],
    setup: "Now something the assistant should not answer: how black holes form.",
    payoff:
      "Nothing in the knowledge base scores above the off-topic threshold, so the gateway refused before calling any model. " +
      "No tokens, no cost, and the trace says so.",
    expect: [{ tenant: "acme", outcome: "refused_low_confidence", backend: null, attempts: [] }],
  },
  {
    id: "sneaky", title: "Off-topic but sounds close", areas: ["Exception handling"], kind: "scenario",
    scenario: "Off-topic but sounds close",
    verdict: /outside customer support/,
    highlights: [".evidence", ".verdict", null],
    setup: "Harder: a message that gets past retrieval. Tell me a joke about cats.",
    payoff:
      "Retrieval found weak matches, so Haiku was asked. It labelled the message out of scope in its intent header, and the gateway refused instead of letting it improvise. " +
      "Retrieval and the model have to back each other up.",
    expect: [{ tenant: "acme", outcome: "refused_out_of_scope", backend: "haiku" }],
  },
  {
    id: "slow", title: "First model too slow", areas: ["Routing and fallback", "Exception handling"], kind: "scenario",
    scenario: "First model too slow",
    verdict: /Sonnet 5\.5 answered after Haiku 5\.5 sent nothing/,
    highlights: [".verdict", ".inspect"],
    setup: "Now failure. Tenant slow haiku gives Haiku only fifty milliseconds to send its first token.",
    payoff:
      "Haiku sent nothing in time, so the gateway moved on and Sonnet answered. The route trace shows both attempts on one time axis. " +
      "Fallback only happens before the first token reaches the client. Once text is on screen, the gateway never switches models mid-answer.",
    expect: [{ tenant: "slow-haiku", outcome: "ok", backend: "sonnet", attempts: ["haiku:timeout_first_token", "sonnet:ok"] }],
  },
  {
    id: "outage", title: "Both models down", areas: ["Routing and fallback"], kind: "scenario",
    scenario: "Both models down",
    verdict: /Backup answered after Haiku 5\.5 and Sonnet 5\.5 both/,
    highlights: [".verdict", ".inspect"],
    setup: "Tenant outage: both real models time out.",
    payoff:
      "Haiku and Sonnet both missed their limit, and the backup answered from the closest stored reply. " +
      "Three attempts, each with its own outcome and timing, and the customer still got an answer.",
    expect: [{ tenant: "outage", outcome: "ok", backend: "mock", attempts: ["haiku:timeout_first_token", "sonnet:timeout_first_token", "mock:ok"] }],
  },
  {
    id: "raw", title: "Raw gateway chat", areas: ["Request path"], kind: "scenario",
    scenario: "Raw gateway chat",
    verdict: /Haiku 5\.5 answered/,
    highlights: ["fieldset.segmented"],
    setup: "The same gateway also exposes a plain chat endpoint, without the support assistant.",
    payoff:
      "Same keys, budget, routing and metering, but no retrieval and no intent. The assistant is one capability on top of the gateway, not baked into it.",
    expect: [{ tenant: "acme", outcome: "ok", backend: "haiku", attempts: ["haiku:ok"] }],
  },
  {
    id: "budget", title: "Out of budget", areas: ["Request path"], kind: "scenario",
    scenario: "Out of budget",
    verdict: /Blocked before anything ran/,
    highlights: [".alert"],
    setup: "Quota. Tenant tiny has a budget of five hundredths of a cent, enough for one answer. The first request goes through.",
    payoff:
      "The second is blocked with H T T P four twenty nine before anything runs. The budget is reserved in Postgres before every backend call, " +
      "and when it can't be covered the gateway fails closed. It doesn't quietly hand out a free backup answer instead.",
    expect: [
      { tenant: "tiny", outcome: "ok", backend: "haiku", attempts: ["haiku:ok"] },
      { tenant: "tiny", outcome: "quota_exceeded", http: 429 },
    ],
  },
  {
    id: "auth", title: "Unknown key", areas: ["Request path"], kind: "auth",
    verdict: /Rejected at the door/,
    highlights: [".alert"],
    setup: "Auth: the same request with a key the gateway has never seen.",
    payoff: "Rejected with H T T P four oh one, before anything else runs.",
    expect: [{ tenant: "(none)", http: 401 }],
  },
  {
    id: "usage", title: "Usage and the stored trace", areas: ["Measurement"], kind: "usage",
    highlights: ["tr.detail"],
    setup:
      "Every one of those requests was recorded. The usage view reads Postgres: requests, spend, and remaining budget for each tenant.",
    payoff:
      "Opening slow haiku's latest request shows the stored route trace: Haiku timed out on its first token, and Sonnet served it, with tokens and cost for each attempt. " +
      "What the console showed live is exactly what was metered.",
  },
  {
    id: "outro", title: "Results and what was cut", areas: ["Measurement", "Judgement"], kind: "card",
    card: {
      heading: "Measured, not asserted",
      lines: [
        "30 held-out questions + 5 off-topic ones, near-duplicates of the knowledge base filtered out",
        "Answers passing an Opus judge, Haiku with retrieval: 34 of 35 · without: 20 of 35",
        "Sonnet: same outcomes as Haiku on all 35, at 20× the cost",
        "Cut on purpose: per-minute rate limits, multi-turn memory, mid-stream recovery",
        "github.com/galihcitta/mini-inference-router",
      ],
    },
    setup:
      "Quality is measured, not asserted. On thirty held-out questions and five off-topic ones, with near-duplicates of the knowledge base filtered out, an Opus judge passes thirty four of Haiku's thirty five answers with retrieval, and only twenty without it. " +
      "Sonnet gets the same outcomes as Haiku at twenty times the cost, so Haiku goes first and Sonnet is there for availability. " +
      "Cut on purpose: per-minute rate limits, multi-turn memory, and mid-stream recovery. The report explains each choice.",
  },
];
