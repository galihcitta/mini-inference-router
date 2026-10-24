import { setTimeout as sleep } from "node:timers/promises";
import { BackendFailure, type Backend, type Chunk } from "./types.ts";

const CANNED = "This is the mock backend. It returns a fixed reply so the gateway path can be exercised without a model.";

export const mockBackend: Backend = {
  id: "mock",
  model: "mock-extractive",
  async *stream(req, entry, signal): AsyncIterable<Chunk> {
    await sleep(entry.latency_ms ?? 150, undefined, { signal });
    if (Math.random() < (entry.fail_rate ?? 0)) throw new BackendFailure("mock: injected failure", 503);
    const text = req.mockReply ?? CANNED;
    const input = Math.ceil(((req.system ?? "") + req.messages.map((m) => m.content).join("")).length / 4);
    yield { type: "usage", input, estimated: true };
    for (let i = 0; i < text.length; i += 8) {
      yield { type: "text", text: text.slice(i, i + 8) };
      await sleep(12, undefined, { signal });
    }
    yield { type: "usage", output: Math.ceil(text.length / 4), estimated: true };
    yield { type: "stop", reason: "end_turn" };
  },
};
