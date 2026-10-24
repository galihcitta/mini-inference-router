export type BackendId = "haiku" | "sonnet" | "mock";

export interface RouteEntry {
  backend: BackendId;
  first_token_ms?: number;
  total_ms?: number;
  latency_ms?: number; // mock only
  fail_rate?: number; // mock only
}

export const DEFAULT_ROUTE: RouteEntry[] = [{ backend: "haiku" }, { backend: "sonnet" }, { backend: "mock" }];

// USD per 1M tokens. tokens x price = micro-dollars.
export const PRICES: Record<BackendId, { in: number; out: number }> = {
  haiku: { in: 0.1, out: 0.5 },
  sonnet: { in: 2, out: 10 },
  mock: { in: 0, out: 0 },
};

export const TIMEOUTS: Record<BackendId, { first_token_ms: number; total_ms: number }> = {
  haiku: { first_token_ms: 4000, total_ms: 30000 },
  sonnet: { first_token_ms: 6000, total_ms: 45000 },
  mock: { first_token_ms: 3000, total_ms: 30000 },
};

export const SUPPORT_MAX_TOKENS = 600;
export const CHAT_MAX_TOKENS = 1024;

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:mir@localhost:55432/mir",
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  adminToken: process.env.ADMIN_TOKEN ?? "", // unset = admin endpoints disabled
  // Public demo: hands the console keys for the demo tenants and opens the read-only usage
  // endpoints. Exposes those tenants' (small, capped) budgets to anyone with the URL. Off by default.
  demoMode: process.env.DEMO_MODE === "1",
  // Eval-only ablation: SUPPORT_RETRIEVAL=off sends the model the customer message without reference
  // answers, and drops the two retrieval-based refusals. Measures what retrieval contributes.
  supportRetrieval: process.env.SUPPORT_RETRIEVAL !== "off",
};

export function costMicros(backend: BackendId, input: number, output: number): number {
  const p = PRICES[backend];
  return Math.ceil(input * p.in + output * p.out);
}
