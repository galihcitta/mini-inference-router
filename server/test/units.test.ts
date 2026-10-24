import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { breaker } from "../src/gateway/breaker.ts";
import { classify } from "../src/gateway/classify.ts";
import { intentGate } from "../src/support/assistant.ts";
import { slotFilter } from "../src/support/slots.ts";

describe("intent header gate", () => {
  it("waits for the closing tag, then commits the rest", () => {
    expect(intentGate.feed("<inte", false)).toEqual({ kind: "pending" });
    expect(intentGate.feed("<intent>get_refund</intent>\nSure", false)).toEqual({ kind: "ok", intent: "get_refund", rest: "Sure" });
  });
  it("rejects replies without the header, unknown labels and runaway headers", () => {
    expect(intentGate.feed("Sure, I can help", false).kind).toBe("bad");
    expect(intentGate.feed("<intent>refund_please</intent>", false).kind).toBe("bad");
    expect(intentGate.feed("<intent>" + "x".repeat(90), false).kind).toBe("bad");
    expect(intentGate.feed("<intent>get_ref", true).kind).toBe("bad");
  });
  it("accepts out_of_scope", () => {
    expect(intentGate.feed("<intent>out_of_scope</intent>", true)).toMatchObject({ kind: "ok", intent: "out_of_scope" });
  });
});

describe("placeholder filter", () => {
  it("replaces a slot split across chunks", () => {
    const f = slotFilter();
    const out = ["Call us at {", "{Customer Support Ph", "one Number}} today"].map((c) => f.push(c)).join("") + f.flush();
    expect(out).toBe("Call us at +62 21 5000 1234 today");
    expect(f.changed).toBe(true);
  });
  it("drops leading whitespace that arrives in its own chunk", () => {
    const f = slotFilter();
    expect(["\n", " ", "Hello there"].map((c) => f.push(c)).join("") + f.flush()).toBe("Hello there");
  });
  it("passes text without slots through untouched", () => {
    const f = slotFilter();
    expect(f.push("a { b } c") + f.flush()).toBe("a { b } c");
    expect(f.changed).toBe(false);
  });
});

describe("error classification", () => {
  const api = (status: number, body: object, msg: string) => Anthropic.APIError.generate(status, body, msg, new Headers());
  it("treats auth and spend limits as account-wide", () => {
    expect(classify(api(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key")).outcome).toBe("account_error");
    expect(classify(api(400, { type: "error", error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } }, "usage limits")).outcome).toBe("account_error");
    expect(classify(api(429, { type: "error", error: { type: "rate_limit_error", error_code: "enforced_spend_limit_reached" } }, "spend")).outcome).toBe("account_error");
  });
  it("separates rate limits, overload and bad requests", () => {
    expect(classify(api(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "rate")).outcome).toBe("rate_limited");
    expect(classify(api(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "overloaded")).outcome).toBe("provider_error");
    expect(classify(api(400, { type: "error", error: { type: "invalid_request_error", message: "thinking.type.disabled is not supported" } }, "bad")).outcome).toBe("bad_request");
  });
});

describe("circuit breaker", () => {
  it("opens after 3 failures, half-opens after 30 s", () => {
    breaker.reset();
    const t = 1_000_000;
    breaker.failure("haiku", t);
    breaker.failure("haiku", t);
    expect(breaker.allows("haiku", t)).toBe(true);
    breaker.failure("haiku", t);
    expect(breaker.allows("haiku", t + 1)).toBe(false);
    expect(breaker.allows("haiku", t + 30_001)).toBe(true);
    breaker.success("haiku");
    expect(breaker.allows("haiku", t)).toBe(true);
  });
});
