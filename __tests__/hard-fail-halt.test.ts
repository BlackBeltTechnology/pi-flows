// Hard-fail halt mechanics. Full runFlow() needs a live model registry, so —
// like flow-abort.test.ts — we exercise the exact pattern flow-execution uses:
// a hard outcome in one wave member trips the run's halt signal, which unwinds
// the in-flight siblings via the same abort race as a user cancel, while the
// final disposition is recorded as `error` (not `aborted`).
import { describe, it, expect } from "vitest";
import { raceWithAbort } from "../extensions/flow-engine/abort-utils.js";
import { FlowCancelledError } from "../extensions/flow-engine/flow-execution.js";
import { resolveRouteOutcome } from "../extensions/flow-engine/failure.js";
import type { AgentResult, FailureInfo } from "../extensions/flow-engine/types.js";

function mkResult(partial: Partial<AgentResult>): AgentResult {
  return {
    success: false, output: "", stderr: "", exitCode: null,
    result: { status: "error", files: [], artifacts: "", summary: "" },
    toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
    ...partial,
  };
}

function slowSibling(ms: number, signal: AbortSignal): Promise<"done" | "aborted"> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("done"), ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve("aborted"); }, { once: true });
  });
}

describe("hard-fail halt", () => {
  it("a hard outcome trips halt and unwinds in-flight siblings", async () => {
    const halt = new AbortController();
    let hardFail: FailureInfo | null = null;

    // One step hard-fails fast; two siblings would run 500ms.
    const hardStep = (async () => {
      const r = mkResult({ outcome: "hard", failureInfo: { outcome: "hard", message: "provider down", source: "api_error" } });
      if (resolveRouteOutcome(r, undefined) === "hard" && !hardFail) {
        hardFail = r.failureInfo!;
        halt.abort();
      }
      return r;
    })();

    const t0 = Date.now();
    let caught: unknown = null;
    try {
      await raceWithAbort(
        Promise.all([hardStep, slowSibling(500, halt.signal), slowSibling(500, halt.signal)]),
        halt.signal,
      );
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - t0;

    // The race unwinds immediately (does NOT wait for the 500ms siblings).
    expect(caught).toBeInstanceOf(FlowCancelledError);
    expect(elapsed).toBeLessThan(200);
    // The hard-fail reason is recorded — distinct from a user abort.
    expect(hardFail).not.toBeNull();
    expect(hardFail!.outcome).toBe("hard");
    expect(hardFail!.message).toBe("provider down");
  });

  it("soft-without-on_error escalation also trips halt", () => {
    // A soft failure with no on_error becomes hard at routing time.
    const soft = mkResult({ outcome: "soft" });
    expect(resolveRouteOutcome(soft, undefined)).toBe("hard");
    // The same soft failure WITH on_error stays recoverable (no halt).
    expect(resolveRouteOutcome(soft, "park")).toBe("soft");
  });
});

// ---- Section 5.1: transient-retry boundary --------------------------------

describe("transient-retry boundary", () => {
  it("agent errors resolve to a TERMINAL outcome (no retry state)", () => {
    // The outcome space is success | soft | hard — there is deliberately no
    // 'retry' outcome. pi-coding-agent owns transient retry; an error that
    // reaches the engine is terminal and is classified, never retried.
    const terminal: Array<AgentResult["outcome"]> = ["success", "soft", "hard"];
    expect(terminal).not.toContain("retry");
    // An API error maps straight to hard (terminal), not a retry signal.
    const apiErr = mkResult({ outcome: "hard", failureInfo: { outcome: "hard", message: "503", source: "api_error" } });
    expect(resolveRouteOutcome(apiErr, "park")).toBe("hard");
  });
});
