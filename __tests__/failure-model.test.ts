// Unit coverage for the node-failure-model: FlowHardError, the structural
// agent classifier, the thrown-error classifier, and outcome-aware routing
// resolution. Pure functions are tested directly (the repo's runFlow path
// needs a live model registry — see flow-abort.test.ts).
import { describe, it, expect } from "vitest";
import { FlowHardError } from "../extensions/flow-engine/types.js";
import type { AgentResult } from "../extensions/flow-engine/types.js";
import {
  classifyAgentOutcome,
  classifyThrownError,
  resolveRouteOutcome,
} from "../extensions/flow-engine/failure.js";

// ---- Section 1.3: FlowHardError -------------------------------------------

describe("FlowHardError", () => {
  it("is an instanceof Error", () => {
    expect(new FlowHardError("x")).toBeInstanceOf(Error);
  });

  it("is distinguishable from a plain Error", () => {
    const hard = new FlowHardError("hard");
    const plain = new Error("plain");
    expect(hard).toBeInstanceOf(FlowHardError);
    expect(plain).not.toBeInstanceOf(FlowHardError);
    expect(hard.name).toBe("FlowHardError");
  });

  it("preserves the message", () => {
    expect(new FlowHardError("boom").message).toBe("boom");
  });
});

// ---- Section 2.1: structural agent classifier -----------------------------

describe("classifyAgentOutcome", () => {
  it("finish(complete) -> success", () => {
    expect(classifyAgentOutcome({ status: "complete" }, undefined).outcome).toBe("success");
  });

  it("finish(error) -> soft", () => {
    const r = classifyAgentOutcome({ status: "error", summary: "task failed" }, undefined);
    expect(r.outcome).toBe("soft");
    expect(r.failureInfo?.message).toBe("task failed");
    expect(r.failureInfo?.source).toBe("agent_finish_error");
  });

  it("finish(blocked) -> soft", () => {
    expect(classifyAgentOutcome({ status: "blocked" }, undefined).outcome).toBe("soft");
  });

  it("no finish + API error -> hard", () => {
    const r = classifyAgentOutcome(undefined, "429 rate limit exceeded");
    expect(r.outcome).toBe("hard");
    expect(r.failureInfo?.source).toBe("api_error");
    expect(r.failureInfo?.message).toContain("429");
  });

  it("no finish + no API error -> soft", () => {
    const r = classifyAgentOutcome(undefined, undefined);
    expect(r.outcome).toBe("soft");
    expect(r.failureInfo?.source).toBe("agent_no_finish");
  });

  it("does not parse error-message text to decide hard vs soft", () => {
    // A finish(error) whose summary mentions 'rate limit' is still SOFT — the
    // discriminator is structural (finish fired), not the message contents.
    const r = classifyAgentOutcome({ status: "error", summary: "rate limit 429 fatal" }, undefined);
    expect(r.outcome).toBe("soft");
  });
});

// ---- Section 6.2 building block: thrown-error classifier ------------------

describe("classifyThrownError", () => {
  it("plain Error -> soft", () => {
    const info = classifyThrownError(new Error("nope"));
    expect(info.outcome).toBe("soft");
    expect(info.source).toBe("thrown_error");
    expect(info.message).toBe("nope");
  });

  it("FlowHardError -> hard", () => {
    const info = classifyThrownError(new FlowHardError("fatal"));
    expect(info.outcome).toBe("hard");
    expect(info.source).toBe("flow_hard_error");
    expect(info.message).toBe("fatal");
  });

  it("non-Error throw -> soft", () => {
    expect(classifyThrownError("string error").outcome).toBe("soft");
  });
});

// ---- Section 4.1: outcome-aware routing resolution ------------------------

function mk(partial: Partial<AgentResult>): AgentResult {
  return {
    success: false,
    output: "",
    stderr: "",
    exitCode: null,
    result: { status: "error", files: [], artifacts: "", summary: "" },
    toolCalls: [],
    duration: 0,
    tokens: { input: 0, output: 0 },
    ...partial,
  };
}

describe("resolveRouteOutcome", () => {
  it("success falls through (outcome=success)", () => {
    expect(resolveRouteOutcome(mk({ success: true, outcome: "success" }), "park")).toBe("success");
  });

  it("soft WITH on_error stays soft", () => {
    expect(resolveRouteOutcome(mk({ outcome: "soft" }), "park")).toBe("soft");
  });

  it("soft WITHOUT on_error escalates to hard (fail-fast)", () => {
    expect(resolveRouteOutcome(mk({ outcome: "soft" }), undefined)).toBe("hard");
  });

  it("hard is hard regardless of on_error", () => {
    expect(resolveRouteOutcome(mk({ outcome: "hard" }), "park")).toBe("hard");
    expect(resolveRouteOutcome(mk({ outcome: "hard" }), undefined)).toBe("hard");
  });

  it("legacy result (no outcome) falls back to success boolean", () => {
    expect(resolveRouteOutcome(mk({ success: true }), undefined)).toBe("success");
    // legacy failure with on_error -> soft (recoverable)
    expect(resolveRouteOutcome(mk({ success: false }), "park")).toBe("soft");
    // legacy failure without on_error -> hard (fail-fast)
    expect(resolveRouteOutcome(mk({ success: false }), undefined)).toBe("hard");
  });
});
