import { pool } from "../db/pool.ts";

// Atomic: the reservation only lands if it fits under the quota. Also tracked on the request row
// so a crash can release it at boot.
export async function reserve(tenantId: string, requestId: string, micros: number): Promise<boolean> {
  const r = await pool.query(
    `with t as (
       update tenants set used_micros = used_micros + $2
       where id = $1 and used_micros + $2 <= quota_micros returning id
     )
     update requests set reserved_micros = reserved_micros + $2
     where id = $3 and exists (select 1 from t) returning id`,
    [tenantId, micros, requestId],
  );
  return (r.rowCount ?? 0) > 0;
}

// Replace a reservation with the actual cost (0 if the attempt used nothing).
export async function settle(tenantId: string, requestId: string, reserved: number, actual: number): Promise<void> {
  await pool.query(
    `with t as (update tenants set used_micros = greatest(0, used_micros - $2 + $3) where id = $1 returning id)
     update requests set reserved_micros = greatest(0, reserved_micros - $2), cost_micros = cost_micros + $3 where id = $4`,
    [tenantId, reserved, actual, requestId],
  );
}

export async function remainingMicros(tenantId: string): Promise<number> {
  const r = await pool.query(`select quota_micros - used_micros as rem from tenants where id = $1`, [tenantId]);
  return r.rows[0]?.rem ?? 0;
}
