import { pool } from "../db/pool.ts";
import type { Attempt, RunResult } from "./executor.ts";

export async function startRequest(id: string, tenantId: string, endpoint: string): Promise<void> {
  await pool.query(`insert into requests (id, tenant_id, endpoint, status) values ($1, $2, $3, 'in_flight')`, [id, tenantId, endpoint]);
}

export interface Totals { input_tokens: number; output_tokens: number; estimated: boolean; cost_micros: number }

export function totals(attempts: Attempt[]): Totals {
  let input = 0, output = 0, est = false, cost = 0;
  for (const a of attempts) {
    input += a.input_tokens ?? 0;
    output += a.output_tokens ?? 0;
    est ||= !!a.usage_estimated;
    cost += a.cost_micros;
  }
  return { input_tokens: input, output_tokens: output, estimated: est, cost_micros: cost };
}

export async function finishRequest(id: string, r: RunResult, latencyMs: number, confidence?: number): Promise<void> {
  const t = totals(r.attempts);
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const a of r.attempts) {
      await client.query(
        `insert into request_attempts (request_id, seq, backend, outcome, ttft_ms, latency_ms, input_tokens, output_tokens, cost_micros, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, a.seq, a.backend, a.outcome, a.ttft_ms ?? null, a.latency_ms ?? null, a.input_tokens ?? null, a.output_tokens ?? null, a.cost_micros, a.error ?? null],
      );
    }
    // cost_micros was accumulated by quota.settle per attempt; keep it as the source of truth.
    await client.query(
      `update requests set status = 'finished', outcome = $2, backend = $3, model = $4, intent = $5, confidence = $6,
         input_tokens = $7, output_tokens = $8, usage_estimated = $9, ttft_ms = $10, latency_ms = $11,
         fallback = $12, sanitized = $13, error = $14, finished_at = now()
       where id = $1`,
      [id, r.outcome, r.backend ?? null, r.model ?? null, r.intent ?? null, confidence ?? null, t.input_tokens, t.output_tokens,
        t.estimated, r.ttft_ms ?? null, latencyMs, r.attempts.length > 1,
        r.sanitized, r.error ?? null],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// Fail-closed refusals before the stream (quota, bad input) still get a row.
export async function recordRejected(id: string, tenantId: string, endpoint: string, outcome: string, error: string): Promise<void> {
  await pool.query(
    `insert into requests (id, tenant_id, endpoint, status, outcome, error, latency_ms, finished_at) values ($1,$2,$3,'finished',$4,$5,0,now())`,
    [id, tenantId, endpoint, outcome, error],
  );
}

const usageSql = (where: string) => `
  select t.id, t.name, count(r.id)::int as requests, coalesce(sum(r.cost_micros), 0)::bigint as cost_micros,
         t.quota_micros, t.used_micros, t.quota_micros - t.used_micros as remaining_micros
  from tenants t left join requests r on r.tenant_id = t.id
  ${where} group by t.id order by t.id`;

const usd = (m: number) => Number((m / 1e6).toFixed(6));
const shapeUsage = (row: Record<string, number | string>) => ({
  id: row.id, name: row.name, requests: row.requests,
  cost_usd: usd(row.cost_micros as number), quota_usd: usd(row.quota_micros as number),
  used_usd: usd(row.used_micros as number), remaining_usd: usd(row.remaining_micros as number),
});

export async function usageFor(tenantId?: string) {
  const r = tenantId ? await pool.query(usageSql("where t.id = $1"), [tenantId]) : await pool.query(usageSql(""));
  return r.rows.map(shapeUsage);
}

export async function recentRequests(tenantId: string, limit: number) {
  const r = await pool.query(
    `select r.*, coalesce((select json_agg(a order by a.seq) from request_attempts a where a.request_id = r.id), '[]') as attempts
     from requests r where r.tenant_id = $1 order by r.created_at desc limit $2`,
    [tenantId, limit],
  );
  return r.rows.map((x) => ({
    id: x.id, created_at: x.created_at, endpoint: x.endpoint, status: x.status, outcome: x.outcome, backend: x.backend, model: x.model,
    intent: x.intent, confidence: x.confidence, input_tokens: x.input_tokens, output_tokens: x.output_tokens,
    usage_estimated: x.usage_estimated, cost_usd: usd(x.cost_micros), ttft_ms: x.ttft_ms, latency_ms: x.latency_ms,
    fallback: x.fallback, sanitized: x.sanitized, error: x.error,
    attempts: (x.attempts as Record<string, unknown>[]).map((a) => ({ ...a, cost_usd: usd(a.cost_micros as number) })),
  }));
}
