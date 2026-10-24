import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.ts";
import type { Backend, BackendRequest, Chunk } from "./types.ts";

// Gateway owns retries and fallback; SDK retries would hide failures and break the first-token timeout.
const client = new Anthropic({ apiKey: env.anthropicKey ?? "missing", maxRetries: 0 });

// Thinking off for a short support answer. Sonnet 5.5 rejects {type:"disabled"} with a 400.
const MODELS = {
  haiku: { model: "claude-haiku-5-5", thinking: { type: "disabled" } },
  sonnet: { model: "claude-sonnet-5-5", thinking: { type: "between_tools" } },
} as const;

export function anthropicBackend(id: "haiku" | "sonnet"): Backend {
  const { model, thinking } = MODELS[id];
  return {
    id,
    model,
    async *stream(req: BackendRequest, _entry, signal): AsyncIterable<Chunk> {
      const stream = await client.messages.create(
        {
          model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages,
          thinking,
          output_config: { effort: "low" },
          stream: true,
        },
        { signal },
      );
      for await (const ev of stream) {
        if (ev.type === "message_start") {
          yield { type: "usage", input: ev.message.usage.input_tokens };
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { type: "text", text: ev.delta.text };
        } else if (ev.type === "message_delta") {
          yield { type: "usage", output: ev.usage.output_tokens };
          if (ev.delta.stop_reason) yield { type: "stop", reason: ev.delta.stop_reason };
        }
      }
    },
  };
}
