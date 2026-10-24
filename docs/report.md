# Technical Report: Mini Inference Router

## Summary

One Node service, deployed on Render, with Postgres (Neon) for tenants, keys and metering. A support assistant sits on top of a gateway. The gateway authenticates each tenant, reserves quota as a cost budget, routes Haiku 5.5 → Sonnet 5.5 → mock, and records every attempt. The assistant retrieves from a 2,000-row knowledge-base slice, has the model state the intent in a header before it answers, and refuses when retrieval and the model don't back each other up.

The eval is built so that its numbers mean something. In the Bitext dataset, a naive random split puts near-duplicates of the held-out questions into the knowledge base, and retrieval alone then scores 97–100%. The held-out set here has those near-duplicates filtered out.

## Routing rules

Each request walks the tenant's route, an ordered allow-list, and skips any backend whose circuit is open. The default route is in cost order: Haiku ($0.10 / $0.50 per million tokens), then Sonnet ($2 / $10), then the mock ($0). The cheapest model that does the job goes first, and the eval checks whether the 20× more expensive model is measurably better on this task.

| Trigger | What happens |
|---|---|
| No first token within the per-backend timeout (4 s Haiku, 6 s Sonnet) | The next backend is tried. Recorded as `timeout_first_token` |
| 429 rate limit, 529 overload, 5xx, network error | The next backend is tried. Each model has its own rate-limit pool |
| Reply doesn't start with a valid `<intent>` header | `unusable_output`. The next backend is tried |
| 401 / 402 / 403, or a spend limit reached | `account_error`. Every Anthropic backend is skipped and the mock serves, because both models share one key |
| The model's safety refusal (`stop_reason: "refusal"`) | Terminal. No fallback, because routing a declined message elsewhere is shopping for a model that will answer it |
| Failure after the first token has reached the client | An `error` event and outcome `partial`. Text already sent can't be taken back, so there's no silent switch |

Circuit breaker: after 3 consecutive failures a backend is skipped for 30 s, then one trial request goes through. Failures caused by a tenant's own timeout overrides (the demo tenants) don't count, so a demo can't trip the circuit for everyone else.

The SDK runs with `maxRetries: 0`. Retrying is the router's job. Hidden SDK retries would distort latency and defeat the first-token timeout.

Every attempt (backend, outcome, time to first token, latency, tokens, cost, error) is stored in `request_attempts` and returned in the `done` event. The console shows it as the attempt trail, and `GET /admin/requests` exposes it.

## Quota and metering

Quota is a budget in micro-dollars, not tokens. Sonnet costs 20× Haiku and the two models use different tokenizers, so a token budget would mean different things depending on which model served. Each attempt reserves its worst case: the estimated input plus `max_tokens`, at that backend's price. The reservation is one conditional `UPDATE`, which only succeeds if it fits under the quota. When the attempt ends, the reservation is replaced with the actual cost. A test fires 25 concurrent reservations at a quota that fits 10 and checks that exactly 10 succeed. With the guard removed, the same test fails.

Before the stream opens, the gateway checks that the cheapest allowed backend fits. That's how an exhausted tenant gets a real `429 quota_exceeded`. If the database is unreachable, the request is refused with a 503, never served unmetered.

Token counts come from the provider stream: input from `message_start`, output from the final `message_delta`. When a stream breaks before the final usage arrives, output is estimated as characters ÷ 4 and marked `estimated`. The mock's numbers are always estimates. A failed attempt that had already received input usage is charged for it. Cost is labelled "estimated" because it comes from the price table, not an invoice.

## Model choice

Claude Haiku 5.5 is the main model. It's fast and cheap (about $0.0002 per support answer), and it reports exact usage in the stream. Claude Sonnet 5.5 is the real fallback: it has its own rate-limit pool, so it covers Haiku being rate-limited, overloaded or slow. The mock stays as the last resort because both Claude models share one key. A revoked key, a reached spend limit or an Anthropic outage takes both down at once, and the mock still answers, with the top retrieved answer.

Both models run with thinking off at effort `low`, since a short grounded answer gains little from it. Haiku takes `thinking: {type: "disabled"}`. Sonnet 5.5 rejects that with a 400 and needs `{type: "between_tools"}` instead. Neither model is sent sampling parameters.

The challenge allows "a local model, a provider free tier, or both". Paying for my own key is a deliberate deviation. In return I get exact usage reporting, a full eval run for about $1, and a deployment that doesn't depend on a local GPU. A per-tenant quota and a low spend limit on the key cap what the public URL can cost.

## Retrieval and the assistant

- **Knowledge base:** 1,998 deduplicated rows, 74 per intent, indexed with MiniSearch (BM25, prefix matching). English function words are dropped, and the top-5 intent vote is weighted by score. On the dev slice this gives 90.6% retrieval-only intent accuracy, up from 86.5% for plain BM25. No embeddings: the questions are short, lexical paraphrases, and lexical retrieval already reaches about 90%.
- **Intent:** the model starts its reply with `<intent>label</intent>`. The gateway holds back the stream until the header parses, so a malformed header can still fall back, and the intent is known before the first answer token.
- **Confidence:** the share of the top 5 retrieved entries that carry the model's intent. 0.8 or more is `high`, 0.4 or more is `medium`, otherwise `low`.
- **Refusal**, three ways:
  - the top retrieval score is below 4, which refuses before any model call (on dev data: 0.3% false refusals, 4 of 5 out-of-domain questions caught);
  - the model labels the message `out_of_scope`;
  - confidence is `low`.
- **Unusable output:** the intent header is validated against the 27 labels. Template placeholders (`{{Order Number}}`) are filled from a demo company profile before prompting, and an in-stream filter replaces any that leak into the answer. Such answers are flagged `sanitized`.

## Evaluation

- **Split:** questions are deduplicated after normalising case and slots. Held-out candidates must have cosine similarity below 0.8 to every knowledge-base question, measured on character 3–5-grams. From those come 27 eval cases (one per intent) plus 3 keyword-style ones, and a separate dev slice of 297 for tuning. There are also 5 hand-written out-of-domain questions for the eval and 5 more for dev. Nothing was tuned on the eval set.
- **Configurations:** tenant `eval-haiku` (route: Haiku only) against `eval-sonnet` (route: Sonnet only). Same prompt, same retrieval, no fallback, so each configuration is a single model. Both run over HTTP against the real service.
- **Metrics:**
  - intent accuracy, with a Wilson 95% interval, next to retrieval-only accuracy as the reference line;
  - answer quality, judged by Claude Opus 5.5 on three yes/no checks (addresses the request; no invented facts or placeholders; refusing or answering was right). Opus is used so the judge isn't grading its own model;
  - refusal rate on out-of-domain questions, and false-refusal rate on in-domain ones;
  - time to first token and total latency, p50 and p95;
  - cost from the `done` events;
  - discordant pairs between the two configurations.

### Results

<!-- RESULTS -->
Run on 2026-10-24 against the local service with real models. Each configuration answered 30 in-domain and 5 out-of-domain cases. Raw results are in `eval/results/`.

| Metric | Retrieval only (mock) | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|---|
| Intent accuracy, in-domain (95% CI) | 93.3% (78.7–98.2) | 96.7% (83.3–99.4) | 96.7% (83.3–99.4) |
| Answer quality (judge, all 3 checks) | not judged | 97.1% (34/35) | 97.1% (34/35) |
| Out-of-domain refused | 2/5 | 5/5 | 5/5 |
| False refusals, in-domain | 0/30 | 1/30 | 1/30 |
| Time to first token p50 / p95 | 210 / 286 ms | 873 / 1,794 ms | 1,287 / 1,504 ms |
| Total latency p50 / p95 | 1,098 / 2,149 ms | 1,331 / 1,856 ms | 1,978 / 2,455 ms |
| Cost per request | $0 | $0.00021 | $0.00422 |
| Cost for the 35-case run | $0 | $0.0072 | $0.1477 |

What the numbers say:
- **Haiku and Sonnet are indistinguishable on this task.** They have zero discordant intent pairs, and the same single judge fail, which is the same case. Sonnet costs 20× more and adds about 400 ms to the first token. That supports the routing order: Haiku first, with Sonnet kept for availability, not quality.
- **Both models beat retrieval alone by one case: 29/30 against 28/30.** At n = 30 that is inside the noise; the intervals overlap almost entirely. Where the model clearly adds value is refusal: it catches all 5 out-of-domain questions, while the retrieval threshold catches 2 before any model call.
- **The one false refusal** is "deleting Business accoumt". The model labelled it correctly as `delete_account`, but the typo broke retrieval, so only 1 of 5 retrieved entries supported that intent, and the low-confidence rule refused it. That's the cost of refusing whenever retrieval and the model disagree. I kept the rule: on these 30 cases it costs 1 false refusal, and it guards against the model being confidently wrong.

**How the judge was checked.** The first version of the judge didn't see the reference answers the assistant was given. It failed about 30% of answers for "inventing" the demo store's phone number and hours, which actually came from those references. I changed the judge to see the same references (`eval/run.ts`) and reran both models. I then read 10 cases myself, including both remaining fails, and agreed with the judge on all 10. The same pass also turned up one real defect, which I fixed before the rerun: an unknown template slot leaked as plain text ("date range business days"). That rerun produced the numbers above. These labels are mine; Galih hasn't reviewed them.

**End-to-end check.** `npm run e2e` runs a Playwright walkthrough of the console against the real server, Postgres and both models, and records a video. It covers:
- the normal path;
- both kinds of refusal;
- fallback from Haiku to Sonnet;
- the mock serving as last resort;
- the raw `/v1/chat` endpoint;
- quota failing closed;
- an unknown key;
- the stored attempt trail in the usage view.

All 9 steps pass.

## Trade-offs accepted

- **Fallback only before the first token.** Mid-stream failures surface as `partial` rather than being retried, because the client has already seen the text.
- **Lexical retrieval.** It's cheaper and good enough on this dataset. It misses paraphrases that share no words, and keyword-only queries are its weak spot.
- **In-memory breaker and index.** Fine for one instance. Several instances would each keep their own breaker state.
- **Render free tier.** The service sleeps after 15 minutes idle, and the first request after that takes about a minute.

## Cut, on purpose

- No tenant-management UI: tenants and keys come from the seed script.
- No monthly quota periods.
- No per-minute rate limits.
- No embeddings or vector database.
- No multi-turn memory.
- No mid-stream recovery.
- No console login beyond pasting a key.
- No prompt caching: the prompt is about 1,100 tokens.
