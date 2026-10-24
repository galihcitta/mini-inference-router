export interface Attempt {
  seq?: number;
  backend: string;
  outcome: string;
  ttft_ms?: number | null;
  latency_ms?: number | null;
  error?: string | null;
}

export interface RetrievalEvent {
  request_id: string;
  entries: { id: string | number; intent: string; question: string; score: number }[];
  retrieval_intent?: string;
  votes?: Record<string, number>;
}

export interface MetaEvent {
  request_id: string;
  intent: string | null;
  confidence: { score: number; level: string; votes: number | Record<string, number>; agrees: boolean } | null;
  backend: string | null;
  model: string | null;
  refused: boolean;
  refusal_reason: string | null;
}

export interface DoneEvent {
  request_id: string;
  outcome: string;
  backend: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null; estimated: boolean } | null;
  cost_usd: number;
  latency_ms: number | null;
  ttft_ms: number | null;
  attempts: Attempt[];
}

export interface TenantUsage {
  id: string;
  name?: string;
  requests?: number;
  cost_usd?: number;
  quota_usd?: number;
  used_usd?: number;
  remaining_usd?: number;
}

export interface RequestRow {
  id: string;
  created_at?: string;
  endpoint?: string;
  outcome?: string | null;
  backend?: string | null;
  model?: string | null;
  intent?: string | null;
  confidence?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  usage_estimated?: boolean | null;
  cost_usd?: number | null;
  ttft_ms?: number | null;
  latency_ms?: number | null;
  fallback?: boolean;
  attempts?: Attempt[];
}
