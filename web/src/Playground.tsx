import { useRef, useState } from "react";
import { describeHttpError, fmtUsd } from "./api";
import { backendName, intentLabel, outcomeLabel, outcomeTone, routeText, verdict } from "./explain";
import { SCENARIOS, type Scenario } from "./scenarios";
import { readSse } from "./sse";
import { useStoredString } from "./storage";
import Trace from "./Trace";
import type { DemoTenant, DoneEvent, MetaEvent, RetrievalEvent } from "./types";

type Endpoint = "/v1/support/chat" | "/v1/chat";

export default function Playground({ demo }: { demo: DemoTenant[] }) {
  const [ownKey, setOwnKey] = useStoredString("mir.tenantKey");
  const [useOwnKey, setUseOwnKey] = useState(demo.length === 0);
  const [tenantId, setTenantId] = useState(demo[0]?.id ?? "");
  const [endpoint, setEndpoint] = useState<Endpoint>("/v1/support/chat");
  const [message, setMessage] = useState("");
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [http, setHttp] = useState<{ status: number; code?: string; detail: string } | null>(null);
  const [streamError, setStreamError] = useState<{ code?: string; message?: string } | null>(null);
  const [retrieval, setRetrieval] = useState<RetrievalEvent | null>(null);
  const [meta, setMeta] = useState<MetaEvent | null>(null);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const demoTenant = demo.find((t) => t.id === tenantId);
  const apiKey = useOwnKey || !demoTenant ? ownKey : demoTenant.key;
  const keyMissing = !apiKey.trim();

  function pick(s: Scenario) {
    setScenario(s);
    setMessage(s.message);
    setEndpoint(s.endpoint ?? "/v1/support/chat");
    if (demo.some((t) => t.id === s.tenant)) {
      setTenantId(s.tenant);
      setUseOwnKey(false);
    }
  }

  async function send() {
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setAnswer("");
    setHttp(null);
    setStreamError(null);
    setRetrieval(null);
    setMeta(null);
    setDone(null);
    const body = endpoint === "/v1/support/chat" ? { message } : { messages: [{ role: "user", content: message }] };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await describeHttpError(res);
        setHttp({ status: res.status, code: /HTTP \d+ (\w+)/.exec(detail)?.[1], detail });
        return;
      }
      for await (const ev of readSse(res.body)) {
        if (ev.event === "retrieval") setRetrieval(ev.data as RetrievalEvent);
        else if (ev.event === "meta") setMeta(ev.data as MetaEvent);
        else if (ev.event === "delta") setAnswer((a) => a + ((ev.data as { text?: string })?.text ?? ""));
        else if (ev.event === "error") setStreamError(ev.data as { code?: string; message?: string });
        else if (ev.event === "done") setDone(ev.data as DoneEvent);
      }
    } catch (e) {
      if (ac.signal.aborted) setStreamError({ code: "client_aborted", message: "Stopped by you." });
      else setHttp({ status: 0, detail: `Network error: ${(e as Error).message}` });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  const said = verdict({ httpStatus: http?.status || undefined, httpCode: http?.code, retrieval, meta, done, running, endpoint });
  const outcome = http ? (http.status === 429 ? "quota_exceeded" : "failed") : done?.outcome;
  const started = running || !!done || !!http;
  const votesFor = meta?.confidence?.votes ?? (retrieval?.retrieval_intent ? retrieval.votes?.[retrieval.retrieval_intent] : undefined);

  return (
    <div className="play">
      <aside className="scenarios" aria-label="Scenarios">
        <h2>Try a scenario</h2>
        <p className="muted small">Each one shows a behaviour of the gateway. Pick one, then send.</p>
        <ul>
          {SCENARIOS.map((s) => (
            <li key={s.id}>
              <button className={`scenario ${scenario?.id === s.id ? "is-active" : ""}`} onClick={() => pick(s)} disabled={running}>
                <span className="scenario-title">{s.title}</span>
                <span className="scenario-watch">{s.watch}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="bench">
        <div className="composer">
          <div className="composer-row">
            {demo.length > 0 && !useOwnKey ? (
              <label className="field grow">
                Tenant
                <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={running}>
                  {demo.map((t) => (
                    <option key={t.id} value={t.id}>{t.id}: {t.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field grow">
                Tenant API key
                <input type="password" value={ownKey} onChange={(e) => setOwnKey(e.target.value)} placeholder="mir_…" autoComplete="off" />
              </label>
            )}
            <fieldset className="segmented" disabled={running}>
              <legend>Endpoint</legend>
              <label className={endpoint === "/v1/support/chat" ? "is-on" : ""}>
                <input type="radio" name="endpoint" checked={endpoint === "/v1/support/chat"} onChange={() => setEndpoint("/v1/support/chat")} />
                Support assistant
              </label>
              <label className={endpoint === "/v1/chat" ? "is-on" : ""}>
                <input type="radio" name="endpoint" checked={endpoint === "/v1/chat"} onChange={() => setEndpoint("/v1/chat")} />
                Raw chat
              </label>
            </fieldset>
          </div>
          {demo.length > 0 && (
            <p className="route-line small">
              {useOwnKey ? "Using your own key." : demoTenant && <>Route for this tenant: {routeText(demoTenant.route)}.</>}{" "}
              <button className="link" onClick={() => setUseOwnKey(!useOwnKey)}>{useOwnKey ? "Use a demo tenant" : "Use my own key"}</button>
            </p>
          )}
          <label className="field">
            Message
            <textarea
              rows={3}
              value={message}
              onChange={(e) => { setMessage(e.target.value); setScenario(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !running && !keyMissing) send(); }}
              placeholder="Ask what a customer would ask, e.g. how do I cancel my order?"
            />
          </label>
          <div className="composer-actions">
            <button className="primary" onClick={send} disabled={running || !message.trim() || keyMissing}>Send</button>
            <button onClick={() => abortRef.current?.abort()} disabled={!running}>Stop</button>
            {scenario && <span className="watch small"><strong>Watch for:</strong> {scenario.watch}</span>}
            {keyMissing && !scenario && <span className="muted small">Add a tenant API key to send.</span>}
          </div>
        </div>

        <div className={`verdict tone-${outcomeTone(outcome)} ${running ? "is-running" : ""}`} aria-live="polite">
          {started ? (
            <>
              <p className="verdict-text">{said}</p>
              {outcome && <span className={`chip tone-${outcomeTone(outcome)}`}>{outcomeLabel(outcome)}</span>}
            </>
          ) : (
            <p className="verdict-text muted">Send a message to see which model answers, what it retrieved, and what it cost.</p>
          )}
        </div>

        {http && <pre className="alert">{http.detail}</pre>}
        {streamError && <pre className="alert">Stream error{streamError.code ? ` (${streamError.code})` : ""}: {streamError.message ?? ""}</pre>}

        <dl className="stats">
          <div><dt>Served by</dt><dd>{done ? backendName(done.backend) : meta?.backend ? backendName(meta.backend) : "—"}</dd></div>
          <div><dt>Intent</dt><dd>{intentLabel(meta?.intent)}</dd></div>
          <div><dt>Confidence</dt><dd>{meta?.confidence ? `${meta.confidence.level} (${meta.confidence.votes} of 5 agree)` : "—"}</dd></div>
          <div><dt>Tokens in / out</dt><dd>{done?.usage ? `${done.usage.input_tokens ?? 0} / ${done.usage.output_tokens ?? 0}${done.usage.estimated ? " est." : ""}` : "—"}</dd></div>
          <div><dt>First token</dt><dd>{done?.ttft_ms != null ? `${done.ttft_ms} ms` : "—"}</dd></div>
          <div><dt>Total time</dt><dd>{done?.latency_ms != null ? `${done.latency_ms} ms` : "—"}</dd></div>
          <div><dt>Cost</dt><dd>{done ? fmtUsd(done.cost_usd) : "—"}</dd></div>
        </dl>

        <div className="panes">
          <section className="answer">
            <h2>Answer</h2>
            <div className={`answer-text ${running ? "is-streaming" : ""}`}>
              {answer || <span className="muted">{running ? "Waiting for the first token…" : "No answer yet."}</span>}
            </div>
          </section>

          <section className="inspect">
            <h2>Route trace</h2>
            {done ? <Trace attempts={done.attempts} total={done.latency_ms} /> : <p className="muted small">{running ? "The trace appears when the request finishes." : "Every backend the request tried, in order, on one time axis."}</p>}

            {endpoint === "/v1/support/chat" && (
              <>
                <h2>Why this intent</h2>
                {retrieval ? (
                  <>
                    <p className="small">
                      {retrieval.entries.length === 0 ? (
                        <>No knowledge-base entry scored above the off-topic threshold of 4{retrieval.top_score != null && <> (best was {retrieval.top_score.toFixed(1)})</>}.</>
                      ) : meta?.intent && votesFor != null ? (
                        <>
                          {votesFor} of the 5 closest entries carry <strong>{intentLabel(meta.intent)}</strong>, the intent the model chose.
                          {retrieval.retrieval_intent && retrieval.retrieval_intent !== meta.intent && <> Retrieval alone would have picked <strong>{intentLabel(retrieval.retrieval_intent)}</strong>.</>}
                        </>
                      ) : (
                        <>Retrieval alone points to <strong>{intentLabel(retrieval.retrieval_intent)}</strong>. Best match score {retrieval.top_score?.toFixed(1)}; below 4 counts as off-topic.</>
                      )}
                    </p>
                    <ol className="evidence">
                      {retrieval.entries.map((e) => (
                        <li key={String(e.id)} className={meta?.intent === e.intent ? "is-match" : ""}>
                          <span className="evidence-q">{e.question}</span>
                          <span className="evidence-meta">{intentLabel(e.intent)}, score {e.score.toFixed(1)}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="muted small">The five closest past questions from the knowledge base, and which intent each one carries.</p>
                )}
              </>
            )}
            {done && <p className="request-id small muted">Request <code>{done.request_id}</code></p>}
          </section>
        </div>
      </section>
    </div>
  );
}
