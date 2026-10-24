# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A small LLM gateway with one capability on top: a customer-support assistant over the Bitext dataset. It's built for a one-day code challenge ([docs/mini-inference-router-challenge.md](docs/mini-inference-router-challenge.md)). Be clear about which document is authoritative for what:

- [docs/mini-inference-router-design.md](docs/mini-inference-router-design.md): the build contract (endpoints, SSE protocol, routing, data model).
- [docs/mini-inference-router-study.md](docs/mini-inference-router-study.md): the evidence behind the choices (dataset profiling, leakage, platform limits).
- [docs/report.md](docs/report.md): the technical report submitted with the challenge.

When the code and the docs disagree, the code is what runs. Fix whichever one is wrong, and say which.

## Layout

```
server/src/
  config.ts          backend ids, prices, timeouts, env
  db/pool.ts         pg pool, schema (create-if-not-exists at boot), orphan reservation release
  gateway/           auth, quota (reserve/settle), breaker, classify, executor (routing + fallback), metering, sse
  backends/          anthropic.ts (Haiku/Sonnet), mock.ts (extractive), registry.ts (setBackend for tests)
  support/           kb.ts (MiniSearch BM25 + vote), assistant.ts (prompt, intent gate, confidence, refusals), slots.ts
  http/app.ts        Fastify routes; serves web/dist
server/test/         vitest against real Postgres, scripted backends
web/                 React + Vite console (own package.json); web/dev/fake-server.mjs for UI work without the server
data/                generated split: kb.jsonl, eval.jsonl, dev.jsonl, ood_*.jsonl
eval/run.ts          end-to-end eval over HTTP + Opus judge; results in eval/results/
scripts/             make_split.py (data), tune.ts (OOD threshold), seed.ts (tenants + keys)
```

## Commands

Requires Node 22+ (ESM, TypeScript run by `tsx`, imports use `.ts` extensions). Local Postgres runs in Docker:

```bash
docker run -d --name mir-pg -e POSTGRES_PASSWORD=mir -e POSTGRES_DB=mir -p 55432:5432 postgres:17-alpine
```

```bash
docker exec mir-pg psql -U postgres -c "create database mir_test"
```

| Task | Command |
|---|---|
| Install and build the console | `npm ci && npm run build` |
| Dev server (reads `.env`) | `npm run dev`, on port 3000 |
| Seed demo tenants (prints keys) | `npm run seed`, or `npm run seed -- acme` |
| Typecheck | `npm run typecheck`, and `cd web && npx tsc --noEmit` |
| Tests | `npm test` (uses database `mir_test`) |
| Retune the OOD threshold | `npx tsx scripts/tune.ts` |
| Browser E2E with video (real models, a few cents) | `npm run e2e` |
| Eval one configuration | `npm run eval -- --key <tenant key> --name haiku` |
| Compare two runs | `npm run eval -- --compare eval/results/haiku.json eval/results/sonnet.json` |
| Regenerate data | `python scripts/make_split.py <bitext csv> data` (needs pandas, scikit-learn) |

Before calling a change done, run the typecheck and the tests. Both must be clean.

## Invariants: don't break these

These are the behaviours the challenge assesses. Invariants 1–7 each have a test in `server/test/request-path.test.ts`. Invariant 8 is a convention with no test.

1. **Fallback only before the first delta.** Once text has reached the client, a failure ends the request with an `error` event and outcome `partial`. Never switch backends mid-answer.
2. **Model refusals are terminal.** `stop_reason: "refusal"` gives `refused_by_model`, with no fallback to another model.
3. **Quota fails closed, and reservations are atomic.**
   - Every attempt calls `reserve()` before contacting a backend, and `settle()` afterwards, even when it fails.
   - The guard lives in the SQL `WHERE used_micros + $r <= quota_micros`. Don't move it into application code.
   - If the database is unreachable, return 503. Never serve without metering.
4. **Quota is micro-dollars, not tokens.** Cost is `tokens × price per 1M`, computed with `costMicros` in `config.ts`.
5. **Every request a tenant makes gets a `requests` row**, including refusals and quota rejections. Every attempt gets a `request_attempts` row. `cost_micros` on the request row is accumulated by `settle()`, so don't recompute it elsewhere.
6. **The intent header gate.** Nothing from a model reaches the client until `<intent>label</intent>` parses to one of the 27 labels or `out_of_scope`. A bad header counts as `unusable_output` and falls back.
7. **The breaker ignores routes with overrides.** An attempt only counts toward the circuit breaker when its route entry has no `first_token_ms`, `total_ms`, `latency_ms` or `fail_rate` override. Otherwise the demo tenants would trip the circuit for everyone.
8. **The SSE contract is shared with `web/`.** If you change an event name or field, update `web/src/types.ts`, the console views, `eval/run.ts`, and the design doc's SSE table in the same change.

## Claude API specifics

Verify these against current Anthropic docs before changing them. Don't rely on memory.

- Model IDs are `claude-haiku-5-5` and `claude-sonnet-5-5`. The judge is `claude-opus-5-5`. Prices are in `config.ts`, `PRICES`.
- The Anthropic client runs with `maxRetries: 0`. Retries and fallback belong to the gateway; SDK retries would hide failures and break the first-token timeout.
- Thinking is turned off differently per model:
  - Haiku: `thinking: {type: "disabled"}`.
  - Sonnet 5.5: `{type: "between_tools"}`. `disabled` returns a 400 there.
  - Opus 5.5 can't turn thinking off.
- Don't send `temperature`, `top_p` or `top_k`; they return a 400.
- Don't send the `fallbacks` parameter. Refusals are handled by the gateway.
- Usage comes from the stream: input from `message_start`, output from the final `message_delta`. Anything estimated must be flagged `estimated`.

## Data and eval rules

- **Never tune on `data/eval.jsonl` or `data/ood_eval.jsonl`.** Thresholds and retrieval settings are tuned on `dev.jsonl` and `ood_dev.jsonl` only, with `scripts/tune.ts`.
- `data/` is generated by `make_split.py` with a fixed seed. Don't hand-edit the split files.
- The KB/eval split is filtered for leakage (dedupe, then cos < 0.8). A naive random split inflates retrieval accuracy to 97–100%, so don't replace it with one.
- With n = 30, a one- or two-case difference between configurations is noise. Report Wilson intervals and discordant pairs, not just the two accuracy numbers.
- Eval runs call real models and cost money (about $1 per full run with the judge). Say so before running one.

## Conventions

- Plain SQL via `pg`, no ORM. Validate with `zod` at the HTTP boundary only; trust internal code.
- Comments explain why, not what. Match the existing density, which is sparse.
- Tests:
  - Integration tests go through `app.inject` with backends scripted via `setBackend`, so they never call a real model.
  - Aim for roughly one focused test per behaviour.
  - For a concurrency or guard test, check that it fails with the guard removed.
- Keep scope tight. This is a one-day build, and the report lists what was cut on purpose ("Cut, on purpose").

## Secrets and accounts

- `.env` is gitignored and holds `ANTHROPIC_API_KEY`, `DATABASE_URL` and `ADMIN_TOKEN`. Never print, log or commit their values.
- Admin endpoints are disabled when `ADMIN_TOKEN` is unset. There is no default token, by design.
- The GitHub repo is `galihcitta/mini-inference-router`. In the maintainer's shell, a `GITHUB_TOKEN` env var points at a different account. Run `gh` as `env -u GITHUB_TOKEN gh ...`.
- Deploys use Render (`render.yaml`) and Neon Postgres. Writing to the deployed database counts as production: confirm with the maintainer first.
