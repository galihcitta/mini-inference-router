import { fmt } from "./api";
import type { Attempt } from "./types";

export default function AttemptTable({ attempts }: { attempts: Attempt[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>backend</th>
            <th>outcome</th>
            <th>ttft_ms</th>
            <th>latency_ms</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a, i) => (
            <tr key={i} className={a.outcome === "ok" ? "" : "bad"}>
              <td>{a.seq ?? i + 1}</td>
              <td>{fmt(a.backend)}</td>
              <td>{fmt(a.outcome)}</td>
              <td className="num">{fmt(a.ttft_ms)}</td>
              <td className="num">{fmt(a.latency_ms)}</td>
              <td className="err">{fmt(a.error)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
