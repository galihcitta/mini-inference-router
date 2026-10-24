import { Fragment, useState } from "react";
import { describeHttpError, fmt, fmtUsd } from "./api";
import AttemptTable from "./AttemptTable";
import { useStoredString } from "./storage";
import type { RequestRow, TenantUsage } from "./types";

async function getJson(path: string, token: string): Promise<unknown> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token.trim()}` } });
  if (!res.ok) throw new Error(await describeHttpError(res));
  return res.json();
}

export default function Usage() {
  const [token, setToken] = useStoredString("mir.adminToken");
  const [tenants, setTenants] = useState<TenantUsage[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadRequests(tenantId: string) {
    setSelected(tenantId);
    setRequests(null);
    setExpanded(new Set());
    try {
      const body = (await getJson(
        `/admin/requests?tenant=${encodeURIComponent(tenantId)}&limit=50`,
        token,
      )) as { requests?: RequestRow[] } | RequestRow[];
      setRequests(Array.isArray(body) ? body : (body.requests ?? []));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const body = (await getJson("/admin/usage", token)) as { tenants?: TenantUsage[] } | TenantUsage[];
      setTenants(Array.isArray(body) ? body : (body.tenants ?? []));
      if (selected) await loadRequests(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="usage">
      <div className="form row">
        <label>
          Admin token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>
        <button className="primary" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <pre className="alert">{error}</pre>}

      {tenants && (
        <>
          <h2>Tenants</h2>
          <p className="muted">Click a tenant to see its recent requests.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>name</th>
                  <th>requests</th>
                  <th>cost</th>
                  <th>used</th>
                  <th>quota</th>
                  <th>remaining</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr
                    key={t.id}
                    className={"clickable" + (t.id === selected ? " selected" : "")}
                    onClick={() => loadRequests(t.id)}
                  >
                    <td><code>{t.id}</code></td>
                    <td>{fmt(t.name)}</td>
                    <td className="num">{fmt(t.requests)}</td>
                    <td className="num">{fmtUsd(t.cost_usd)}</td>
                    <td className="num">{fmtUsd(t.used_usd)}</td>
                    <td className="num">{fmtUsd(t.quota_usd)}</td>
                    <td className="num">{fmtUsd(t.remaining_usd)}</td>
                  </tr>
                ))}
                {tenants.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">No tenants.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selected && (
        <>
          <h2>
            Recent requests: <code>{selected}</code>
          </h2>
          {!requests ? (
            <p className="muted">Loading…</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>created</th>
                    <th>endpoint</th>
                    <th>outcome</th>
                    <th>backend</th>
                    <th>model</th>
                    <th>intent</th>
                    <th>conf.</th>
                    <th>tokens in/out</th>
                    <th>cost</th>
                    <th>ttft_ms</th>
                    <th>latency_ms</th>
                    <th>fallback</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const open = expanded.has(r.id);
                    const n = r.attempts?.length ?? 0;
                    return (
                      <Fragment key={r.id}>
                        <tr className="clickable" onClick={() => toggle(r.id)} title={r.id}>
                          <td>{n > 0 ? (open ? "▾" : "▸") : ""}</td>
                          <td>{r.created_at ? new Date(r.created_at).toLocaleString() : "–"}</td>
                          <td><code>{fmt(r.endpoint)}</code></td>
                          <td>{fmt(r.outcome)}</td>
                          <td>{fmt(r.backend)}</td>
                          <td>{fmt(r.model)}</td>
                          <td>{fmt(r.intent)}</td>
                          <td className="num">{fmt(r.confidence)}</td>
                          <td className="num">
                            {fmt(r.input_tokens)} / {fmt(r.output_tokens)}
                            {r.usage_estimated ? " (est.)" : ""}
                          </td>
                          <td className="num">{fmtUsd(r.cost_usd)}</td>
                          <td className="num">{fmt(r.ttft_ms)}</td>
                          <td className="num">{fmt(r.latency_ms)}</td>
                          <td>{r.fallback ? <span className="badge fallback small">fallback</span> : "no"}</td>
                        </tr>
                        {open && (
                          <tr className="detail">
                            <td colSpan={13}>
                              <div className="muted">request_id <code>{r.id}</code></div>
                              {n > 0 ? <AttemptTable attempts={r.attempts!} /> : <span className="muted">No attempts.</span>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {requests.length === 0 && (
                    <tr>
                      <td colSpan={13} className="muted">No requests.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
