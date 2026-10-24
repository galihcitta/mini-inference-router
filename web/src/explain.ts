// Plain-language names for what the gateway reports. One vocabulary, used everywhere.
import type { Attempt, DoneEvent, MetaEvent, RetrievalEvent, RouteEntry } from "./types";

export const BACKEND_NAME: Record<string, string> = { haiku: "Haiku 5.5", sonnet: "Sonnet 5.5", mock: "Backup" };
export const backendName = (b: string | null | undefined) => (b ? BACKEND_NAME[b] ?? b : "No model");

const ATTEMPT: Record<string, string> = {
  ok: "Answered",
  timeout_first_token: "Sent nothing before its time limit",
  timeout_total: "Took longer than its overall limit",
  rate_limited: "Rate-limited by the provider",
  provider_error: "Provider returned an error",
  account_error: "API key or billing problem",
  bad_request: "Provider rejected the request",
  unusable_output: "Reply was unusable",
  skipped_quota: "Skipped: budget can't cover it",
  skipped_account: "Skipped: same API key just failed",
  circuit_open: "Skipped: failing repeatedly, paused",
  refused_by_model: "Model declined to answer",
  partial: "Failed partway through the answer",
  client_aborted: "Stopped by you",
};
export const attemptLabel = (o: string) => ATTEMPT[o] ?? o;
export const attemptFailed = (o: string) => o !== "ok";
export const attemptSkipped = (o: string) => o.startsWith("skipped") || o === "circuit_open";

const OUTCOME: Record<string, string> = {
  ok: "Answered",
  refused_low_confidence: "Refused: not confident",
  refused_out_of_scope: "Refused: off-topic",
  refused_by_model: "Refused by model",
  partial: "Incomplete answer",
  failed: "All backends failed",
  client_aborted: "Stopped",
  quota_exceeded: "Over budget",
};
export const outcomeLabel = (o: string | null | undefined) => (o ? OUTCOME[o] ?? o : "Unknown");
export const outcomeTone = (o: string | null | undefined) =>
  o === "ok" ? "good" : o?.startsWith("refused") ? "warn" : o ? "bad" : "neutral";

export const intentLabel = (i: string | null | undefined) => (i ? i.replace(/_/g, " ") : "—");

export function routeText(route: RouteEntry[]): string {
  return route
    .map((e) => {
      const limits = [e.first_token_ms !== undefined && `${e.first_token_ms} ms limit`, e.fail_rate !== undefined && `fails ${Math.round(e.fail_rate * 100)}%`, e.latency_ms !== undefined && `${e.latency_ms} ms delay`].filter(Boolean);
      return backendName(e.backend) + (limits.length ? ` (${limits.join(", ")})` : "");
    })
    .join(" → ");
}

function failureClause(a: Attempt): string {
  const n = backendName(a.backend);
  switch (a.outcome) {
    case "timeout_first_token": return `${n} sent nothing within its time limit`;
    case "timeout_total": return `${n} ran past its overall limit`;
    case "rate_limited": return `${n} was rate-limited`;
    case "provider_error": return `${n} returned an error`;
    case "account_error": return `${n} hit an API key or billing problem`;
    case "unusable_output": return `${n} gave an unusable reply`;
    case "bad_request": return `${n} rejected the request`;
    case "circuit_open": return `${n} was paused after repeated failures`;
    case "skipped_account": return `${n} was skipped (same API key)`;
    case "skipped_quota": return `${n} was skipped (budget)`;
    default: return `${n}: ${a.outcome}`;
  }
}

// "Haiku 5.5 and Sonnet 5.5 both sent nothing within their time limits" rather than repeating the clause.
function failures(attempts: Attempt[]): string {
  if (attempts.length === 2 && attempts[0].outcome === attempts[1].outcome && attempts[0].outcome === "timeout_first_token") {
    return `${backendName(attempts[0].backend)} and ${backendName(attempts[1].backend)} both sent nothing within their time limits`;
  }
  return join(attempts.map(failureClause));
}

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// One sentence that says what happened to the request.
export function verdict(s: { httpStatus?: number; httpCode?: string; retrieval?: RetrievalEvent | null; meta?: MetaEvent | null; done?: DoneEvent | null; running: boolean; endpoint: string }): string {
  if (s.httpStatus === 401) return "Rejected at the door: that API key isn't valid. Nothing ran and nothing was charged.";
  if (s.httpStatus === 429) return "Blocked before anything ran: this tenant's budget can't cover another request.";
  if (s.httpStatus === 400) return "Rejected: the request wasn't valid. See the details below.";
  if (s.httpStatus === 503) return "Refused safely: the database is unreachable, so nothing can be metered.";
  if (s.httpStatus) return `The server answered HTTP ${s.httpStatus}${s.httpCode ? ` (${s.httpCode})` : ""}.`;

  const d = s.done;
  if (!d) {
    if (!s.running) return "";
    if (s.meta?.backend) return `${backendName(s.meta.backend)} is answering…`;
    if (s.retrieval) return "Found related answers in the knowledge base. Asking the first model on the route…";
    return s.endpoint === "/v1/chat" ? "Routing to the first model on the route…" : "Searching the knowledge base…";
  }
  const failed = d.attempts.filter((a) => a.outcome !== "ok" && a.backend !== d.backend);
  const after = failed.length ? ` after ${failures(failed)}` : " on the first try";
  const who = backendName(d.backend);
  switch (d.outcome) {
    case "ok": return `${who} answered${after}.`;
    case "refused_low_confidence":
      return d.attempts.length === 0
        ? "Refused without calling a model: nothing in the knowledge base is close to this question, so it cost nothing."
        : `Refused: ${who} read this as “${intentLabel(s.meta?.intent)}”, but the retrieved answers don't back that up.`;
    case "refused_out_of_scope": return `Refused: ${who} judged this outside customer support.`;
    case "refused_by_model": return `${who} declined to answer. The gateway doesn't send declined requests to another model.`;
    case "partial": return `${who} failed partway through, so the answer is incomplete. Text already sent can't be retried elsewhere.`;
    case "quota_exceeded": return "Stopped: the budget ran out before any backend could take the request.";
    case "client_aborted": return "Stopped by you. Tokens used so far were still metered.";
    default: return `No backend could answer: ${failures(d.attempts)}.`;
  }
}
