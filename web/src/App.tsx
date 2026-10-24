import { useEffect, useState } from "react";
import Playground from "./Playground";
import Usage from "./Usage";
import type { DemoTenant } from "./types";

type Tab = "playground" | "usage";

export default function App() {
  const [tab, setTab] = useState<Tab>("playground");
  const [demo, setDemo] = useState<{ enabled: boolean; tenants: DemoTenant[] } | null>(null);

  useEffect(() => {
    fetch("/demo")
      .then((r) => (r.ok ? r.json() : { enabled: false, tenants: [] }))
      .then(setDemo)
      .catch(() => setDemo({ enabled: false, tenants: [] }));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Inference Router</h1>
          <p className="tagline">A gateway that routes each request across Haiku, Sonnet and a backup, and shows its work.</p>
        </div>
        <nav className="tabs" aria-label="Views">
          <button className={tab === "playground" ? "is-on" : ""} aria-current={tab === "playground"} onClick={() => setTab("playground")}>Playground</button>
          <button className={tab === "usage" ? "is-on" : ""} aria-current={tab === "usage"} onClick={() => setTab("usage")}>Usage</button>
        </nav>
        {demo?.enabled && <span className="demo-flag" title="Demo tenants and their keys are provided by the server">Demo mode</span>}
      </header>
      {!demo ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <>
          {/* Keep both mounted so switching views doesn't lose a streaming answer. */}
          <main hidden={tab !== "playground"}>
            <Playground demo={demo.tenants} />
          </main>
          <main hidden={tab !== "usage"}>
            <Usage demo={demo.enabled} active={tab === "usage"} />
          </main>
        </>
      )}
    </div>
  );
}
