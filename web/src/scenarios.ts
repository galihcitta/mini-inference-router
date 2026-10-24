// Guided scenarios: each one exercises a behaviour the gateway is built to show.
export interface Scenario { id: string; tenant: string; title: string; watch: string; message: string; endpoint?: "/v1/support/chat" | "/v1/chat" }

export const SCENARIOS: Scenario[] = [
  { id: "normal", tenant: "acme", title: "A normal question", watch: "Haiku answers on the first try and the intent is detected.", message: "I ordered the wrong size. Can I cancel order ORD-10482?" },
  { id: "slow", tenant: "slow-haiku", title: "First model too slow", watch: "Haiku gets only 50 ms to start, so it times out and Sonnet takes over.", message: "Where is my refund? It has been two weeks." },
  { id: "outage", tenant: "outage", title: "Both models down", watch: "Haiku and Sonnet both time out; the backup answers from the closest stored reply.", message: "How do I change my shipping address?" },
  { id: "flaky", tenant: "flaky-mock", title: "Unreliable backend", watch: "This tenant's first backend fails half the time and is slow. Run it twice.", message: "How do I download my invoice?" },
  { id: "offtopic", tenant: "acme", title: "Clearly off-topic", watch: "Nothing in the knowledge base is close, so it's refused before any model runs. Cost: $0.", message: "Explain how black holes form." },
  { id: "sneaky", tenant: "acme", title: "Off-topic but sounds close", watch: "Retrieval finds weak matches, so Haiku is asked; it labels the message out of scope.", message: "Tell me a joke about cats." },
  { id: "budget", tenant: "tiny", title: "Out of budget", watch: "This tenant can afford one answer. Send it twice: the second is blocked with HTTP 429.", message: "How do I get my invoice?" },
  { id: "raw", tenant: "acme", title: "Raw gateway chat", watch: "The same gateway without the support assistant: no retrieval, no intent.", message: "Say hello in exactly five words.", endpoint: "/v1/chat" },
];
