# Mini Inference Router: Study Note

Study of [mini-inference-router-challenge.md](mini-inference-router-challenge.md), done 2026-10-23, before any build. Updated 2026-10-24: Claude Haiku 5.5 replaces Gemini 2.5 Flash-Lite as the real backend, with Claude Sonnet 5.5 as the real fallback and the mock as the last resort.

Labels used below:
- **Known**: measured with the scripts in [study/](study/), or quoted from an official doc page.
- **Inferred**: a reasoned conclusion that hasn't been tested yet.
- **Recommended**: a design choice.

## Verdict

The build is feasible in a day if it deploys first and routes Haiku 5.5 → Sonnet 5.5 → mock. The mock stays because both real models share one Anthropic key: a bad key, a spent limit or an Anthropic outage takes both down at once. Three findings should shape the plan:

1. **A random split inflates the eval.** Bitext questions are paraphrases of shared templates. In a naive random split, 3–23% of held-out questions already appear word for word in the knowledge base. Retrieval alone then scores 97–100% intent accuracy, so the LLM's number means nothing. With a deduplicated split, retrieval alone scores about 93%. That is the bar the LLM has to beat.
2. **Thirty cases can only detect large differences.** 28/30 correct has a 95% confidence interval of 79–98%. Two configurations a few cases apart are tied. Report intervals and paired disagreements, not just two accuracy numbers.
3. **The streaming design has to settle intent, confidence and refusal before the first token.** Fallback can only swap backends before anything has been sent to the client, and a refusal shouldn't start halfway through a streamed answer.

The streaming spikes did not run. There is no Anthropic API key and no host account on this machine. The [Spikes](#spikes-blocked-on-galih) section has the exact commands, about 10 minutes of work in total.

## Dataset facts (known, reproducible)

Source: Hugging Face, `bitext/Bitext-customer-support-llm-chatbot-training-dataset`, file `Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv`. Reproduce with `python study/profile.py <csv>` (the scripts need `pandas duckdb scikit-learn statsmodels`).

| Fact | Value |
|---|---|
| Rows | 26,872 (no nulls) |
| Intents / categories | 27 / **11** (the README says 10 and lists category names that don't match the data; trust the data) |
| Rows per intent | 950–1,000 |
| Duplicate questions | 2,237 exact duplicates; 3,035 after lowercasing and collapsing `{{slots}}` |
| Same question under two intents | 0, so the labels are clean |
| Question length | median 9 words, max 16 |
| Response length | median 90 words, p95 200 |
| Responses containing `{{placeholders}}` | 13,006 (48%), e.g. `{{Order Number}}`, `{{Website URL}}` |
| Offensive-language rows (flag W) | 1,288 |
| Undocumented flags | Z (5,286 rows), S (417), V (77) |
| Out-of-domain examples | **none** |

What this means:
- **The "knowledge base" has no facts in it.** Responses are generic, templated agent replies ("Let me quickly check..."). They contain no real policies, prices or dates. Answer quality can therefore only mean "on-intent and appropriate"; factual accuracy can't be measured. Reference-overlap metrics like ROUGE would mostly reward copying the template style.
- **Placeholders will leak into model output.** Retrieved answers carry `{{...}}` slots, and the model will copy them. Recommended: before prompting, fill slots from a fixed demo company profile, and treat any `{{` left in the output as unusable output.
- **Refusal can't be tested from the dataset.** Every row is in-domain, so the eval needs a handful of hand-written out-of-domain questions.

## Eval split and the retrieval baseline (known)

Reproduce with `python study/leakage.py <csv>` and `python study/confidence.py <csv>`. Similarity is cosine over character 3–5-gram TF-IDF, which is lexical. Paraphrase leakage that shares no wording is missed, so read the leakage figures as a lower bound.

| Split (30 held-out cases, 3 seeds) | Exact duplicate in KB | Near-duplicate (cos ≥ 0.9) | Retrieval-only intent accuracy |
|---|---|---|---|
| Naive random, KB = 2,000 rows | 3–10% | 23–37% | 100% |
| Naive random, KB = all other rows | 10–23% | 53–63% | 97–100% |
| **Deduplicated, held-out filtered to cos < 0.8 vs KB, KB = 2,000** | 0% | 0% | 90–93% (93.0% on n = 3,240) |

Retrieval confidence is well calibrated (n = 3,240, deduplicated split, top-5 nearest neighbours):

| Top-5 votes for the winning intent | Share of cases | Accuracy |
|---|---|---|
| 5/5 | 63% | 99.9% |
| 4/5 | 18% | 95.0% |
| 3/5 | 15% | 72.1% |
| ≤ 2/5 | 4% | 28–58% |

- The most confused pairs are close siblings: `get_invoice` ↔ `check_invoice`, `track_refund` ↔ `get_refund`, `edit_account` ↔ `switch_account`, and the order intents.
- Keyword-style queries (flag K, e.g. "cancelling order") drop to 78%. These are the hard cases worth including in the held-out set.

Wilson 95% intervals for n = 30:

| Score | Interval |
|---|---|
| 30/30 | 88.6–100% |
| 29/30 | 83.3–99.4% |
| 28/30 | 78.7–98.2% |
| 27/30 | 74.4–96.5% |

**Recommended eval design:**
- **Knowledge base:** 2,000 deduplicated rows, about 74 per intent. That is small enough for an in-memory lexical index in Node, with no vector database.
- **Held-out set:** 27 cases (one per intent) plus 3 keyword-style (flag K) cases, all drawn from the filtered pool. Add 5 hand-written out-of-domain questions, scored separately as refusal rate.
- **Reference line:** report the retrieval-only intent accuracy next to both LLM configurations. Retrieval already computes it, so it costs nothing extra.
- **The two configurations:** Haiku 5.5 against Sonnet 5.5, same prompt, both at effort `low` with thinking off. This answers the question the routing order raises: is the fallback model worth 20 times the price on this task? If it isn't measurably better, the order (cheap first) is justified; if it is, the report says so. Include 1–2 offensive-language (flag W) cases to see whether either model's safety classifiers decline them.
- **Comparison:** run both configurations on the same 30 cases and report discordant pairs (one configuration right, the other wrong). Don't call a gap of 1–2 cases a win.
- **Answer quality:** an LLM-judge rubric with three yes/no checks: addresses the request, no invented facts or leftover placeholders, refuses when it should. Hand-label 10 cases to check that the judge agrees with you.
- **Throttling:** run the eval at concurrency 1–2 and log 429 responses as their own outcome. Hiding retries inside latency would distort the latency numbers.
- **Re-measure in Node.** The 93% baseline is Python TF-IDF; a Node BM25 index will score somewhat differently.

## Platform choices

Sourced by a docs pass on 2026-10-23. Every row below is Known (official page) unless marked.

| Need | Choice | Why | Unverified |
|---|---|---|---|
| Real model | **Claude Haiku 5.5** (`claude-haiku-5-5`) via the official `@anthropic-ai/sdk`, paid with your own API key | Published price of $0.10 input / $0.50 output per 1M tokens for prompts up to 100K tokens ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)). The stream reports exact token usage: input tokens in `message_start`, output tokens in `message_delta`. Standard Start-tier limit is 1,000 RPM, 2M input and 400K output tokens per minute ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)) | A new account may start on a lower "Evaluation" tier; spike 1 reads the actual limits from the response headers |
| Host | **Render free web service** ([free](https://render.com/docs/free)) | A long-running Node process keeps SSE and in-memory indexes simple; 750 instance-hours a month | SSE buffering and request timeout aren't documented |
| Database | **Neon Postgres** ([pricing](https://neon.com/pricing)) | Permanent free tier, no card, standard Postgres | — |
| Real fallback | **Claude Sonnet 5.5** (`claude-sonnet-5-5`), same SDK and key | $2 / $10 per 1M tokens. Its own rate-limit pool, separate from Haiku's, so it covers a Haiku rate limit, overload (529) or slow first token | Start-tier limits for Sonnet 5.5: spike 1 headers |
| Last resort | Mock, in-process | Covers account-wide failures (key, spend limit, outage) that hit both real models; configurable latency and failure for tests and demos | — |

Limits and terms that matter for this build:
- **Render** spins down after 15 minutes idle and takes about a minute to wake. Recommended: an external pinger keeps it warm (inferred: one service running all month uses about 744 hours, under the 750 allowance), and the README should say so.
- **Render's disk is ephemeral**, which rules out SQLite.
- **Neon** suspends after 5 minutes idle, so the first query after a pause is slow.
- **The challenge doesn't list paying as an option.** It says you "may use" a local model or a free tier. My reading (inferred) is that a self-funded key isn't forbidden. State it in the report as a deliberate choice: exact usage reporting, and an eval that costs under $1.
- **The public URL spends your money.** Anyone with the URL and a tenant key can run up the bill. Two guards:
  - the per-tenant quota, which now protects real spend;
  - a low spend limit (e.g. $5) set on the Console Billing page. Past it, the API returns HTTP 400 `invalid_request_error`; the gateway should treat that as an account-wide failure: skip Sonnet (same key) and go straight to the mock.
- **Both models think by default** (Haiku effort default `medium`, Sonnet `high`). Thinking tokens bill as output, count toward `max_tokens`, and delay the first visible token. The support route turns thinking off at effort `low`, but the request shape differs per model:
  - Haiku 5.5: `thinking: {type: "disabled"}`, allowed at effort `high` or below.
  - Sonnet 5.5: `{type: "disabled"}` returns 400. Send `thinking: {type: "between_tools"}` instead, also at effort `high` or below.
  - Both: sampling parameters (`temperature`, etc.) return 400 on the current API version, so don't send them.
- **The tokenizers differ** (inferred from the docs: Haiku 5.5 uses a newer tokenizer than the Sonnet line). The same prompt gives different token counts on each model, so quota is metered in estimated cost, not raw tokens (collision 4).
- **Refusals.** A decline is HTTP 200 with `stop_reason: "refusal"`. Haiku 5.5 has no server-side fallback; don't send the `fallbacks` parameter to either model. Sonnet 5.5 also declines in a `reasoning_extraction` category, so the system prompt must not ask the model to write out its reasoning. The gateway handles refusals itself (collision 7).
- **Vercel Hobby** is the alternative if you want Next.js. It allows a 300-second streaming cap and is non-commercial only ([limits](https://vercel.com/docs/functions/limitations), [plan](https://vercel.com/docs/plans/hobby)). Circuit-breaker state wouldn't survive across serverless instances there.
- **Not chosen:**
  - Gemini 2.5 Flash-Lite: the free-tier fallback if you'd rather not pay. Similar price ($0.10 / $0.40), but its free limits are only shown inside AI Studio, its OpenAI-compatible endpoint is in beta, and streamed usage is undocumented. Its free-tier prompts may also be used to improve Google's products.
  - Groq: free limits and card rule are unconfirmed.
  - OpenRouter: no small free text model confirmed.
  - Cerebras: needs a card.
  - Fly.io: no free tier for new organisations.
- **Ollama** (inferred): won't fit small free instances. Use it as a local-dev backend at most.

Recommended: serve the built React (Vite) console as static files from the same Node service. One deploy, no CORS.

### Cost table

The gateway's declared price table, used for every request's estimated cost:

| Backend | Input $/1M | Output $/1M | Note |
|---|---|---|---|
| `claude-haiku-5-5` | 0.10 | 0.50 | Prompts up to 100K tokens; $0.50 / $2.50 beyond, which this app never reaches |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 20× Haiku |
| `mock` | 0 | 0 | — |

Expected spend (inferred; the eval measures the real figures):

| Item | Assumption | Estimated cost |
|---|---|---|
| One support request on Haiku, effort `low`, thinking off | ~1,100 input tokens (system prompt + 5 retrieved answers + question), ~150 output | ~$0.0002 |
| The same request on Sonnet (fallback) | Same tokens | ~$0.004 |
| Full eval | 35 cases × 2 configurations (~$0.15), plus one judge call per answer on Claude Opus 5.5 ($4 / $20, ~$0.85), so the judge isn't grading its own model | ~$1 |

Thinking tokens bill as output, so `done` events and metering rows record total output tokens as the API reports them, thinking included.

## Where the constraints collide

| # | Collision | Resolution (recommended) |
|---|---|---|
| 1 | "Use a local model" vs "deploy it" | The deployed real models are Claude Haiku 5.5 and Sonnet 5.5 on your own key, stated in the report as a trade-off against the "free tier or local" wording. Ollama is optional, local only. |
| 2 | A streamed answer vs structured fields (intent, retrieved entries, confidence, refusal) | Three-event SSE protocol: `meta` (intent, retrieved, confidence, chosen backend), then answer `delta` events, then `done` (usage, cost, latency, fallback trail). Retrieval, intent and the refusal decision all happen before generation starts. |
| 3 | Fallback once tokens are flowing | Two timeouts per backend: time to first token (about 3–5 s, tuned separately for Haiku and Sonnet after the spike) and total. Fallback fires only before the first token. A failure mid-stream ends with an `error` event and outcome `partial`, with no silent switch, because sent tokens can't be taken back. Record every attempt in the request's fallback trail. |
| 4 | Fail-closed quota when token counts arrive at the end | Quota is a cost budget (micro-dollars), not tokens, because Sonnet costs 20× Haiku and the tokenizers differ. Reserve the worst case for the backend about to be called (estimated input + `max_tokens` at its price) with one conditional `UPDATE ... SET used = used + $r WHERE used + $r <= quota RETURNING`; on fallback, release and re-reserve at the next backend's price. Settle to actual usage at `done`. Thinking counts toward `max_tokens`, so the reservation already covers it. If the database is unreachable, reject with 503 rather than allow. |
| 5 | "Estimated cost" from per-token prices | The [cost table](#cost-table): Haiku 5.5 and Sonnet 5.5 at their published rates, mock at $0. Called "estimated" because it's computed from the price table, not read from an invoice. |
| 6 | Exact token usage from the stream | Documented for both Claude models: input tokens arrive in `message_start`, cumulative output tokens in the final `message_delta`. The SDK's `finalMessage().usage` gives both. Spike 1 confirms it. Mock usage is a local estimate, marked `estimated = true`. |
| 7 | "Unusable model output" | Branch on `stop_reason` before reading content:<br>• `refusal` ends the request as a refusal (outcome `model_refusal`). It does not fall back: sending a declined message on to another model is shopping for a model that will answer it, and Sonnet applies the same policy.<br>• `max_tokens` with no text block (thinking ate the cap) is unusable.<br>Then the text checks: empty, over the length cap, leftover `{{`, or contradicts the `meta` intent. If an LLM call returns JSON for intent, validate it against a schema, retry once, then fall back to the retrieval intent. |
| 8 | Provider rate limits vs the eval | About 35 cases × 2 configurations, plus judge calls, is roughly 140 calls. Well inside Start-tier limits, and each model has its own pool; a new account's lower Evaluation tier may still throttle bursts, hence low concurrency and logged 429s. A 429 with `error_code: "enforced_spend_limit_reached"` has no `retry-after`, so don't retry it. |
| 9 | "Defensible routing" | Rules, in order: (a) the tenant's allow-list of backends; (b) a circuit breaker that skips a backend after N consecutive failures for T seconds; (c) cost order: Haiku, then Sonnet, then mock. The cheapest model that does the job goes first; the eval checks Sonnet isn't measurably better. Errors that are account-wide (401, spend limit) skip straight to the mock. The mock doubles as an extractive fallback that returns the top retrieved answer, with configurable latency and failure rate. Log which rule decided each request. |

## Requirements map

Every "must" in the challenge and every assessed area, mapped to its evidence.

| Requirement | Feature | Demo step | Check that proves it |
|---|---|---|---|
| Streaming chat endpoint | `POST /v1/chat`, SSE `meta`/`delta`/`done` | Answer appears token by token in the playground | `curl -N` against the deployed URL shows deltas arriving at intervals; test asserts ≥ 2 deltas before `done` |
| Per-tenant API key auth | Hashed keys in Postgres, middleware | Wrong key gets a 401 | Tests: missing, unknown and revoked key each get 401, and none creates a metering row with tokens |
| Quota fails closed with a clear error | Reserve/settle (collision 4) | Low-quota tenant gets 429 with `{error:"quota_exceeded", remaining}` | Test: 10 parallel requests at the quota edge, admitted total ≤ quota; database down returns 503 |
| Metering: model, tokens, latency, cost, outcome | `requests` table, one row per request including failures | Usage view | Test: row tokens equal provider-reported usage on a recorded response; failed and refused requests still have rows |
| ≥ 2 backends, defensible rules | Haiku 5.5 → Sonnet 5.5 → mock; rules in collision 9 | Playground shows the chosen backend and the rule that chose it | Unit tests per rule |
| Fallback recorded and inspectable | Attempt trail on each request row, returned in `done` | Demo tenants with tiny first-token timeouts (`slow-haiku`, `outage`) show real timeouts falling back in the UI | Test: injected timeout gives trail `[primary: timeout, fallback: ok]` and the request row matches |
| Retrieval over KB slice | In-memory BM25 over 2,000 rows | Retrieved entries panel | Eval reports retrieval-only intent accuracy (expect ~93%, re-measured in Node) |
| Answer, intent, retrieved, confidence | `meta` event fields | All visible in the playground | Schema test on the `meta` event |
| Unusable output handled | Collision 7 | Mock configured to return garbage or placeholders | Tests per unusable case: outcome recorded, no garbage shown as an answer |
| Refuse on low confidence | Refuse if top-5 votes ≤ 3/5, or LLM intent ≠ retrieval intent (to tune) | An out-of-domain question gets a refusal | Eval: refusal rate on 5 out-of-domain cases, false-refusal rate on 30 in-domain |
| Console: playground + usage view | React (Vite) served by the Node service | Both screens | Manual demo, recorded in the video |
| Eval: ~30 cases, 4 metrics, 2 configurations | `npm run eval -- --config a\|b` | Report table in the README | Intervals, discordant pairs, judge-vs-hand agreement on 10 cases |
| Deployed, real model serving real requests | Render + Neon + Haiku 5.5 / Sonnet 5.5 | The URL | `curl` against the deployed URL returns a response served by `claude-haiku-5-5`, with non-zero provider-reported tokens |
| Invalid input, timeouts | Request schema validation (400 with field errors), the two timeouts | — | Tests: malformed body, oversized message, slow mock |
| Judgement: what was cut | Cut list below, in the report | — | — |

## One-day budget (recommended)

| Time | Work |
|---|---|
| 0:00–0:30 | Spikes, then deploy a hello-world to Render + Neon. Deploy first, so platform surprises show up at hour 0, not hour 7. |
| 0:30–2:30 | Gateway: auth, quota, metering, SSE protocol, Haiku 5.5 + mock, routing rules, fallback trail |
| 2:30–4:00 | Support assistant: KB slice, BM25, `meta` event, confidence, refusal, unusable-output checks |
| 4:00–5:30 | Console: playground and usage view |
| 5:30–6:30 | Eval script; run both configurations |
| 6:30–7:30 | Failure-path tests, report, video |
| 7:30–8:00 | Buffer |

**Cut list (recommended, to state in the report):**
- No tenant-management UI: tenants and keys are seeded by script.
- No per-minute rate limiting beyond the token/cost quota.
- No embeddings or vector database.
- No multi-turn conversation memory.
- No mid-stream recovery: one fallback hop, before the first token only.
- Circuit-breaker state lives in memory and resets on restart.
- Single region.
- No console login beyond pasting an API key.

## Spikes (blocked on Galih)

Neither spike could run here: there is no `ANTHROPIC_API_KEY` and no Render/Vercel login on this machine.

**1. Provider streaming and usage.** Create an API key in the Claude Console, set a low spend limit on the Billing page, export the key as `ANTHROPIC_API_KEY`, then run:

```bash
curl -sS -N -D - https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2026-10-21" -H "content-type: application/json" -d '{"model":"claude-haiku-5-5","max_tokens":1024,"stream":true,"thinking":{"type":"disabled"},"output_config":{"effort":"low"},"messages":[{"role":"user","content":"A customer asks how refunds work. Answer in 40 words."}]}'
```

- **Pass:**
  - HTTP 200;
  - `message_start` carries `message.usage.input_tokens`;
  - several `content_block_delta` events with `text_delta` arrive incrementally;
  - the final `message_delta` carries `usage.output_tokens` and `stop_reason: "end_turn"`.
- **Read the headers too:** `anthropic-ratelimit-requests-limit` and `anthropic-ratelimit-output-tokens-limit` show the tier the new account is actually on.
- **Fail:**
  - 401: wrong key.
  - 400: request shape wrong; read the error message before changing anything.
  - 429: account limits too low for the eval; lower eval concurrency.
  - Missing usage fields: unexpected, since they're documented. Collision 6 would then need a local token estimate.
- Note the time to first token. It sets Haiku's first-token timeout.
- Run it again for Sonnet, with the model and thinking fields changed (`disabled` returns 400 on Sonnet 5.5):

```bash
curl -sS -N -D - https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2026-10-21" -H "content-type: application/json" -d '{"model":"claude-sonnet-5-5","max_tokens":1024,"stream":true,"thinking":{"type":"between_tools"},"output_config":{"effort":"low"},"messages":[{"role":"user","content":"A customer asks how refunds work. Answer in 40 words."}]}'
```

  Same pass criteria. Its time to first token sets Sonnet's timeout, and its rate-limit headers show Sonnet's separate pool.

**2. Host streaming.** Deploy this as a Render web service and run `curl -N <url>`:

```js
require("http").createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const t = setInterval(() => { res.write(`data: ${i++} ${Date.now()}\n\n`); if (i === 20) { clearInterval(t); res.end(); } }, 500);
}).listen(process.env.PORT || 3000);
```

- **Pass:** lines arrive about 500 ms apart.
- **Fail:** all 20 arrive at once after 10 s, meaning a proxy is buffering. Add an `X-Accel-Buffering: no` header and retest, or switch host.

If either spike fails, update the Platform choices and Collisions sections before building.

## Still unverified

- The new account's actual rate-limit tier, and the time to first token of Haiku 5.5 and Sonnet 5.5: spike 1.
- Whether Haiku's or Sonnet's safety classifiers decline the dataset's offensive-language (flag W) customer messages. Inferred possible, since `general_harms` "can also trigger" on benign work. The eval's W cases show it.
- Render SSE buffering and request timeout: spike 2.
- Whether Node BM25 matches the 93% Python TF-IDF baseline: measure during the build.
- Whether LLM intent beats retrieval on the deduplicated split: that's what the eval is for. With n = 30, expect a tie unless the gap is several cases.
- Meaning of the undocumented flags Z, S and V: harmless for this build.
