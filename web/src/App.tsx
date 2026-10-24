import { useState } from "react";
import Playground from "./Playground";
import Usage from "./Usage";

type Tab = "playground" | "usage";

export default function App() {
  const [tab, setTab] = useState<Tab>("playground");
  return (
    <div className="app">
      <header className="topbar">
        <h1>Inference Router Console</h1>
        <nav className="tabs">
          <button className={tab === "playground" ? "active" : ""} onClick={() => setTab("playground")}>
            Playground
          </button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>
            Usage
          </button>
        </nav>
      </header>
      {/* Keep both mounted so switching tabs doesn't lose a streaming answer. */}
      <div hidden={tab !== "playground"}>
        <Playground />
      </div>
      <div hidden={tab !== "usage"}>
        <Usage />
      </div>
    </div>
  );
}
