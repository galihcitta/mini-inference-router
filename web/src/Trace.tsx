import { attemptFailed, attemptLabel, attemptSkipped, backendName } from "./explain";
import type { Attempt } from "./types";

const ms = (v: number) => `${Math.round(v).toLocaleString()} ms`;

// Attempts run one after another, so each starts where the previous one ended.
export default function Trace({ attempts, total }: { attempts: Attempt[]; total?: number | null }) {
  if (!attempts.length) {
    return <p className="trace-empty">No model was called for this request.</p>;
  }
  let t = 0;
  const rows = attempts.map((a) => {
    const start = t;
    const dur = a.latency_ms ?? 0;
    t += dur;
    return { a, start, dur };
  });
  const span = Math.max(total ?? 0, t, 1);
  const pct = (v: number) => `${(v / span) * 100}%`;

  return (
    <div className="trace" role="table" aria-label="Route trace">
      <div className="trace-axis" role="row" aria-hidden="true">
        <span />
        <span className="axis-scale">
          <span>0</span>
          <span>{ms(span)}</span>
        </span>
        <span />
      </div>
      {rows.map(({ a, start, dur }, i) => {
        const skipped = attemptSkipped(a.outcome);
        const failed = attemptFailed(a.outcome);
        const ttft = a.ttft_ms ?? null;
        return (
          <div className={`trace-row ${failed ? "is-failed" : "is-ok"} ${skipped ? "is-skipped" : ""}`} role="row" key={i} style={{ animationDelay: `${i * 120}ms` }}>
            <span className={`trace-name b-${a.backend}`} role="cell">
              <span className="dot" aria-hidden="true" />
              {backendName(a.backend)}
            </span>
            <span className="trace-lane" role="cell">
              {skipped ? (
                <span className="trace-skip" style={{ left: pct(start) }} title={attemptLabel(a.outcome)} />
              ) : (
                <span className={`trace-bar b-${a.backend}`} style={{ left: pct(start), width: `max(3px, ${pct(dur)})` }}>
                  {!failed && ttft !== null && dur > 0 && <span className="trace-wait" style={{ width: `${Math.min(100, (ttft / dur) * 100)}%` }} />}
                </span>
              )}
            </span>
            <span className="trace-note" role="cell">
              <span className="trace-outcome">{attemptLabel(a.outcome)}</span>
              <span className="trace-time">
                {skipped ? "not called" : !failed && ttft !== null ? `first token ${ms(ttft)}, done ${ms(dur)}` : ms(dur)}
              </span>
              {a.error && <span className="trace-error">{a.error}</span>}
            </span>
          </div>
        );
      })}
      <p className="trace-legend">
        <span className="key wait" /> waiting for the first token <span className="key stream" /> streaming the answer <span className="key fail" /> failed attempt
      </p>
    </div>
  );
}
