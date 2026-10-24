import pg from "pg";
import { env } from "../config.ts";

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
  ssl: /neon\.tech|sslmode=require/.test(env.databaseUrl) ? { rejectUnauthorized: true } : undefined,
});
// pg returns bigint as string; our values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

const SCHEMA = `
create table if not exists tenants (
  id text primary key,
  name text not null,
  quota_micros bigint not null,
  used_micros bigint not null default 0,
  route jsonb not null default '[{"backend":"haiku"},{"backend":"sonnet"},{"backend":"mock"}]',
  created_at timestamptz not null default now()
);
create table if not exists api_keys (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  key_hash bytea not null unique,
  prefix text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists requests (
  id uuid primary key,
  tenant_id text not null references tenants(id),
  endpoint text not null,
  status text not null,
  outcome text,
  backend text,
  model text,
  intent text,
  confidence real,
  input_tokens int,
  output_tokens int,
  usage_estimated boolean,
  cost_micros bigint not null default 0,
  reserved_micros bigint not null default 0,
  ttft_ms int,
  latency_ms int,
  fallback boolean not null default false,
  sanitized boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists request_attempts (
  request_id uuid not null references requests(id),
  seq int not null,
  backend text not null,
  outcome text not null,
  ttft_ms int,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  cost_micros bigint not null default 0,
  error text,
  primary key (request_id, seq)
);
create index if not exists requests_tenant_created on requests (tenant_id, created_at desc);
`;

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}

// Single instance: any request still in flight at boot belongs to a dead process.
export async function releaseOrphans(): Promise<number> {
  const r = await pool.query(`
    with dead as (
      update requests set status = 'aborted', outcome = coalesce(outcome, 'failed'), error = 'process restarted', finished_at = now()
      where status = 'in_flight' returning tenant_id, reserved_micros
    ), sums as (select tenant_id, sum(reserved_micros) s from dead group by tenant_id)
    update tenants t set used_micros = greatest(0, t.used_micros - sums.s) from sums where t.id = sums.tenant_id
    returning t.id`);
  return r.rowCount ?? 0;
}
