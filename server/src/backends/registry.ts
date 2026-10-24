import type { BackendId } from "../config.ts";
import { anthropicBackend } from "./anthropic.ts";
import { mockBackend } from "./mock.ts";
import type { Backend } from "./types.ts";

export const backends: Record<BackendId, Backend> = {
  haiku: anthropicBackend("haiku"),
  sonnet: anthropicBackend("sonnet"),
  mock: mockBackend,
};

// Tests swap in scripted backends.
export function setBackend(b: Backend): void {
  backends[b.id] = b;
}
