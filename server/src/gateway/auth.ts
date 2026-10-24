import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.ts";
import { DEFAULT_ROUTE, env, type RouteEntry } from "../config.ts";

export interface Tenant {
  id: string;
  name: string;
  quota_micros: number;
  used_micros: number;
  route: RouteEntry[];
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newApiKey(): string {
  const bytes = randomBytes(32);
  return "mir_" + Array.from(bytes, (b) => BASE62[b % 62]).join("");
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest();

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m ? m[1] : null;
}

export async function tenantForKey(key: string | null): Promise<Tenant | null> {
  if (!key || !key.startsWith("mir_")) return null;
  const r = await pool.query(
    `select t.id, t.name, t.quota_micros, t.used_micros, t.route
     from api_keys k join tenants t on t.id = k.tenant_id
     where k.key_hash = $1 and k.revoked_at is null`,
    [hashKey(key)],
  );
  if (!r.rowCount) return null;
  const t = r.rows[0];
  return { ...t, route: Array.isArray(t.route) && t.route.length ? t.route : DEFAULT_ROUTE };
}

export function isAdmin(header: string | undefined): boolean {
  const got = Buffer.from(bearer(header) ?? "");
  const want = Buffer.from(env.adminToken);
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export const DEMO_TENANTS = ["acme", "slow-haiku", "outage", "flaky-mock", "tiny"];

export interface DemoTenant { id: string; name: string; key: string; route: RouteEntry[] }

// Issues one fresh key per existing demo tenant for this process. Old keys keep working.
export async function issueDemoKeys(): Promise<DemoTenant[]> {
  const r = await pool.query(`select id, name, route from tenants where id = any($1) order by array_position($1, id)`, [DEMO_TENANTS]);
  const out = [];
  for (const t of r.rows) {
    const key = newApiKey();
    await pool.query(`insert into api_keys (tenant_id, key_hash, prefix) values ($1, $2, $3)`, [t.id, hashKey(key), key.slice(0, 8)]);
    out.push({ id: t.id as string, name: t.name as string, key, route: t.route as RouteEntry[] });
  }
  return out;
}
