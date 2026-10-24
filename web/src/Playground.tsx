import { useRef, useState } from "react";
import { describeHttpError, fmt, fmtUsd } from "./api";
import AttemptTable from "./AttemptTable";
import { readSse } from "./sse";
import { useStoredString } from "./storage";
import type { DoneEvent, MetaEvent, RetrievalEvent } from "./types";

type Endpoint = "/v1/support/chat" | "/v1/chat";

export default function Playground() {
  const [apiKey, setApiKey] = useStoredString("mir.tenantKey");
  const [endpoint, setEndpoint] = useState<Endpoint>("/v1/support/chat");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [httpError, setHttpError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<{ code?: string; message?: string } | null>(null);
  const [retrieval, setRetrieval] = useState<RetrievalEvent | null>(null);
  const [meta, setMeta] = useState<MetaEvent | null>(null);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setAnswer("");
    setHttpError(null);
    setStreamError(null);
    setRetrieval(null);
    setMeta(null);
    setDone(null);
    const body =
      endpoint === "/v1/support/chat" ? { message } : { messages: [{ role: "user", content: message }] };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        setHttpError(await describeHttpError(res));
        return;
      }
      if (!res.body) {
        setHttpError("Response has no body");
        return;
      }
      for await (const ev of readSse(res.body)) {
        switch (ev.event) {
          case "retrieval":
            setRetrieval(ev.data as RetrievalEvent);
            break;
          case "meta":
            setMeta(ev.data as MetaEvent);
            break;
          case "delta":
            setAnswer((a) => a + ((ev.data as { text?: string })?.text ?? ""));
            break;
          case "error":
            setStreamError(ev.data as { code?: string; message?: string });
            break;
          case "done":
            setDone(ev.data as DoneEvent);
            break;
        }
      }
    } catch (e) {
      if (ac.signal.aborted) setStreamError({ code: "client_aborted", message: "Stopped by you" });
      else setHttpError(`Network error: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  const attempts = done?.attempts ?? [];
  const fallback = attempts.length > 1;

  return (
    <div className="playground">
      <section className="main-col">
        <div className="form">
          <label>
            Tenant API key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="mir_..."
              autoComplete="off"
            />
          </label>
          <fieldset className="endpoint">
            <legend>Endpoint</legend>
            {(["/v1/support/chat", "/v1/chat"] as Endpoint[]).map((ep) => (
              <label key={ep} className="inline">
                <input type="radio" name="endpoint" checked={endpoint === ep} onChange={() => setEndpoint(ep)} />
                <code>{ep}</code>
              </label>
            ))}
          </fieldset>
          <label>
            Message
            <textarea
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !running) send();
              }}
              placeholder="How do I cancel my order?"
            />
          </label>
          <div className="buttons">
            <button className="primary" onClick={send} disabled={running || !message.trim()}>
              Send
            </button>
            <button onClick={() => abortRef.current?.abort()} disabled={!running}>
              Stop
            </button>
            {running && <span className="muted">streaming…</span>}
          </div>
        </div>

        {httpError && <pre className="alert">{httpError}</pre>}
        {streamError && (
          <pre className="alert">
            Stream error{streamError.code ? ` ${streamError.code}` : ""}: {streamError.message ?? ""}
          </pre>
        )}

        <div className="answer">
          <h2>Answer</h2>
          {meta?.refused && <div className="badge warn">Refused: {fmt(meta.refusal_reason)}</div>}
          <div className="answer-text">{answer || <span className="muted">No answer yet.</span>}</div>
        </div>
      </section>

      <aside className="side-col">
        <h2>Request details</h2>
        {fallback && <div className="badge fallback">Fallback fired ({attempts.length} attempts)</div>}
        <dl className="kv">
          <dt>request_id</dt>
          <dd><code>{fmt(done?.request_id ?? meta?.request_id ?? retrieval?.request_id)}</code></dd>
          <dt>outcome</dt>
          <dd>{fmt(done?.outcome)}</dd>
          <dt>backend</dt>
          <dd>{fmt(done?.backend ?? meta?.backend)}</dd>
          <dt>model</dt>
          <dd>{fmt(meta?.model)}</dd>
          <dt>intent</dt>
          <dd>{fmt(meta?.intent)}</dd>
          <dt>confidence</dt>
          <dd>
            {meta?.confidence ? (
              <>
                {fmt(meta.confidence.score)} ({meta.confidence.level}), votes {fmt(meta.confidence.votes)},{" "}
                {meta.confidence.agrees ? "agrees with retrieval" : "disagrees with retrieval"}
              </>
            ) : (
              "–"
            )}
          </dd>
          <dt>refused</dt>
          <dd>
            {meta ? (meta.refused ? `yes: ${fmt(meta.refusal_reason)}` : "no") : "–"}
          </dd>
          <dt>tokens in / out</dt>
          <dd>
            {done?.usage ? (
              <>
                {fmt(done.usage.input_tokens)} / {fmt(done.usage.output_tokens)}
                {done.usage.estimated && <span className="badge small">estimated</span>}
              </>
            ) : (
              "–"
            )}
          </dd>
          <dt>ttft_ms</dt>
          <dd>{fmt(done?.ttft_ms)}</dd>
          <dt>latency_ms</dt>
          <dd>{fmt(done?.latency_ms)}</dd>
          <dt>cost_usd</dt>
          <dd>{fmtUsd(done?.cost_usd)}</dd>
        </dl>

        {attempts.length > 0 && (
          <>
            <h3>Attempt trail</h3>
            <AttemptTable attempts={attempts} />
          </>
        )}

        {retrieval && (
          <>
            <h3>Retrieved entries</h3>
            {retrieval.retrieval_intent && (
              <p className="muted">
                retrieval intent: {retrieval.retrieval_intent}
                {retrieval.votes ? `, votes ${fmt(retrieval.votes)}` : ""}
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>intent</th>
                    <th>question</th>
                    <th>score</th>
                  </tr>
                </thead>
                <tbody>
                  {(retrieval.entries ?? []).map((e, i) => (
                    <tr key={`${e.id}-${i}`}>
                      <td>{e.intent}</td>
                      <td>{e.question}</td>
                      <td className="num">{fmt(e.score)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
