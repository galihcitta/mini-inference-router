import { Fragment, useEffect, useState } from "react";
import { describeHttpError, fmtUsd } from "./api";
import { backendName, intentLabel, outcomeLabel, outcomeTone } from "./explain";
import { useStoredString } from "./storage";
import Trace from "./Trace";
import type { RequestRow, TenantUsage } from "./types";

async function getJson(path: string, token: string): Promise<unknown> {
  const res = await fetch(path, { headers: token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {} });
  if (!res.ok) throw new Error(await describeHttpError(res));
  return res.json();
}

const ago = (iso?: string) => {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
};

export default function Usage({ demo, active }: { demo: boolean; active: boolean }) {
  const [token, setToken] = useStoredString("mir.adminToken");
  const [tenants, setTenants] = useState<TenantUsage[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadRequests(tenantId: string) {
    setSelected(tenantId);
    setRequests(null);
    setOpen(null);
    try {
      const body = (await getJson(`/admin/requests?tenant=${encodeURIComponent(tenantId)}&limit=50`, token)) as { requests?: RequestRow[] } | RequestRow[];
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

  // In demo mode there's no token to wait for, so load whenever the view is opened.
  useEffect(() => {
    if (demo && active) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, active]);

  return (
    <div className="usage">
      <div className="usage-head">
        <div>
          <h2>Usage by tenant</h2>
          <p className="muted small">Every request is metered in Postgres, including refusals and blocked ones. Budgets are in dollars, not tokens. Spending counts all time; the budget meter counts since the tenant was last reset.</p>
        </div>
        <div className="usage-controls">
          {!demo && (
            <label className="field">
              Admin token
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            </label>
          )}
          <button className="primary" onClick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        </div>
      </div>

      {error && <pre className="alert">{error}</pre>}
      {!tenants && !error && <p className="muted">{demo ? "Loading…" : "Enter the admin token and press Refresh."}</p>}

      {tenants && (
        <div className="table-wrap">
          <table className="tenants">
            <thead>
              <tr>
                <th>Tenant</th>
                <th className="num">Requests</th>
                <th className="num">Spent, all time</th>
                <th>Budget used</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const quota = t.quota_usd ?? 0;
                const used = t.used_usd ?? 0;
                const share = quota > 0 ? Math.min(1, used / quota) : 0;
                return (
                  <tr key={t.id} className={`clickable ${t.id === selected ? "is-selected" : ""}`} onClick={() => loadRequests(t.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && loadRequests(t.id)}>
                    <td>
                      <span className="tenant-id">{t.id}</span>
                      {t.name && <span className="muted small"> {t.name}</span>}
                    </td>
                    <td className="num">{t.requests ?? 0}</td>
                    <td className="num">{fmtUsd(t.cost_usd, 4)}</td>
                    <td>
                      <div className={`meter ${share >= 0.9 ? "is-full" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={used} aria-label={`${t.id} budget used`}>
                        <span style={{ width: `${share * 100}%` }} />
                      </div>
                      <span className="meter-text small">{fmtUsd(used, 4)} of {fmtUsd(quota, 4)}, {fmtUsd(t.remaining_usd, 4)} left</span>
                    </td>
                  </tr>
                );
              })}
              {tenants.length === 0 && (
                <tr><td colSpan={4} className="muted">No tenants yet. Run the seed script.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <section className="requests">
          <h2>Recent requests for {selected}</h2>
          <p className="muted small">Click a request to see its route trace, as stored in the database.</p>
          {!requests ? (
            <p className="muted">Loading…</p>
          ) : (
            <div className="table-wrap">
              <table className="request-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Result</th>
                    <th>Served by</th>
                    <th>Intent</th>
                    <th className="num">Cost</th>
                    <th className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => {
                    const isOpen = open === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr className={`clickable ${isOpen ? "is-open" : ""}`} onClick={() => setOpen(isOpen ? null : r.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                          <td className="small">{ago(r.created_at)}{r.endpoint === "/v1/chat" && <span className="muted"> raw chat</span>}</td>
                          <td>
                            <span className={`chip tone-${outcomeTone(r.outcome)}`}>{outcomeLabel(r.outcome)}</span>
                            {r.fallback && <span className="chip tone-neutral">fallback</span>}
                          </td>
                          <td>{r.backend ? <span className={`who b-${r.backend}`}><span className="dot" />{backendName(r.backend)}</span> : <span className="muted">no model</span>}</td>
                          <td>{intentLabel(r.intent)}</td>
                          <td className="num">{fmtUsd(r.cost_usd)}</td>
                          <td className="num">{r.latency_ms != null ? `${r.latency_ms} ms` : "—"}</td>
                        </tr>
                        {isOpen && (
                          <tr className="detail">
                            <td colSpan={6}>
                              <Trace attempts={r.attempts ?? []} total={r.latency_ms} />
                              <p className="small muted">
                                Tokens {r.input_tokens ?? 0} in / {r.output_tokens ?? 0} out{r.usage_estimated ? " (estimated)" : ""}. Request <code>{r.id}</code>
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {requests.length === 0 && (
                    <tr><td colSpan={6} className="muted">No requests yet for this tenant.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
