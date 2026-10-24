// Creates (or resets) the demo tenants and prints a fresh API key for each.
// Usage: npm run seed            -> all tenants
//        npm run seed -- acme    -> only the named tenants
import { migrate, pool } from "../server/src/db/pool.ts";
import { hashKey, newApiKey } from "../server/src/gateway/auth.ts";
import type { RouteEntry } from "../server/src/config.ts";

const usd = (d: number) => Math.round(d * 1e6);
const H: RouteEntry = { backend: "haiku" }, S: RouteEntry = { backend: "sonnet" }, M: RouteEntry = { backend: "mock" };

const TENANTS: { id: string; name: string; quota: number; route: RouteEntry[] }[] = [
  { id: "acme", name: "Acme (normal path)", quota: usd(2), route: [H, S, M] },
  { id: "slow-haiku", name: "Haiku forced to time out", quota: usd(1), route: [{ backend: "haiku", first_token_ms: 50 }, S, M] },
  { id: "outage", name: "Both real models time out", quota: usd(1), route: [{ backend: "haiku", first_token_ms: 50 }, { backend: "sonnet", first_token_ms: 50 }, M] },
  { id: "flaky-mock", name: "Mock first, 50% failure, 800 ms", quota: usd(1), route: [{ backend: "mock", fail_rate: 0.5, latency_ms: 800 }, H] },
  { id: "tiny", name: "Tiny quota (fails closed)", quota: 500, route: [H, S, M] },
  { id: "eval-haiku", name: "Eval: Haiku only", quota: usd(2), route: [H] },
  { id: "eval-sonnet", name: "Eval: Sonnet only", quota: usd(3), route: [S] },
  { id: "mock-only", name: "Mock only (offline dev)", quota: usd(1), route: [M] },
];

await migrate();
const only = process.argv.slice(2);
for (const t of TENANTS.filter((t) => !only.length || only.includes(t.id))) {
  await pool.query(
    `insert into tenants (id, name, quota_micros, route) values ($1, $2, $3, $4)
     on conflict (id) do update set name = $2, quota_micros = $3, used_micros = 0, route = $4`,
    [t.id, t.name, t.quota, JSON.stringify(t.route)],
  );
  await pool.query(`update api_keys set revoked_at = now() where tenant_id = $1 and revoked_at is null`, [t.id]);
  const key = newApiKey();
  await pool.query(`insert into api_keys (tenant_id, key_hash, prefix) values ($1, $2, $3)`, [t.id, hashKey(key), key.slice(0, 8)]);
  console.log(`${t.id.padEnd(12)} ${key}`);
}
await pool.end();
