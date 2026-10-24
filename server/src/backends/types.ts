import type { BackendId, RouteEntry } from "../config.ts";

export interface Msg { role: "user" | "assistant"; content: string }

export interface BackendRequest {
  system?: string;
  messages: Msg[];
  maxTokens: number;
  // The mock answers extractively from retrieval instead of generating.
  mockReply?: string;
}

export type Chunk =
  | { type: "text"; text: string }
  | { type: "usage"; input?: number; output?: number; estimated?: boolean }
  | { type: "stop"; reason: string };

export interface Backend {
  id: BackendId;
  model: string;
  stream(req: BackendRequest, entry: RouteEntry, signal: AbortSignal): AsyncIterable<Chunk>;
}

// A failure the gateway should classify; thrown by the mock and by the classifier tests.
export class BackendFailure extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
