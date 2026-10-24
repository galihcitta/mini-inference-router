import Anthropic from "@anthropic-ai/sdk";
import { BackendFailure } from "../backends/types.ts";

export type FailureOutcome = "rate_limited" | "provider_error" | "account_error" | "bad_request";

// Maps a thrown backend error to an attempt outcome. account_error means the key or the
// account is unusable, so every Anthropic backend is skipped for this request.
export function classify(err: unknown): { outcome: FailureOutcome; detail: string } {
  if (err instanceof Anthropic.APIError) {
    const body = JSON.stringify(err.error ?? {});
    const detail = `${err.status ?? "?"} ${err.type ?? ""} ${err.message}`.slice(0, 300);
    const s = err.status ?? 0;
    if (s === 401 || s === 402 || s === 403) return { outcome: "account_error", detail };
    if (/spend.?limit|usage limit|credit balance|billing/i.test(body + err.message)) return { outcome: "account_error", detail };
    if (s === 429) return { outcome: "rate_limited", detail };
    if (s === 400 || s === 404 || s === 413 || s === 422) return { outcome: "bad_request", detail };
    return { outcome: "provider_error", detail };
  }
  if (err instanceof BackendFailure) {
    if (err.status === 429) return { outcome: "rate_limited", detail: err.message };
    if (err.status === 401) return { outcome: "account_error", detail: err.message };
    return { outcome: "provider_error", detail: err.message };
  }
  return { outcome: "provider_error", detail: String((err as Error)?.message ?? err).slice(0, 300) };
}
