// Wiring coverage for the template-expansion engine (harden-flow-wiring §1).
// expandTemplateVariables is the resolution layer every node's inputs/task flow
// through. These tests lock its behavior for all supported variable forms,
// typed-output resolution, input wiring, flow-ref propagation, and edge cases.

import { describe, it, expect } from "vitest";
import { expandTemplateVariables } from "../extensions/flow-engine/execution.js";
import type { TemplateContext, AgentResult } from "../extensions/flow-engine/types.js";

function ctx(partial: Partial<TemplateContext> = {}): TemplateContext {
  return {
    task: "the-task",
    inputs: {},
    results: {},
    loopCounters: {},
    loopMaxIterations: {},
    ...partial,
  };
}

/** Mirror flow-execution's storeResult merge so resolution matches runtime. */
function storeResult(results: Record<string, any>, stepId: string, result: Partial<AgentResult> & { typedOutputs?: Record<string, string> }): void {
  results[stepId] = {
    fullOutput: result.output ?? "",
    status: result.result?.status ?? "complete",
    summary: result.result?.summary ?? "",
    artifacts: result.result?.artifacts ?? "",
    files: (result.result?.files ?? []).map((f) => f.path).join(", "),
    ...(result.typedOutputs ?? {}),
  };
}

describe("expandTemplateVariables — all variable forms (§1.1)", () => {
  const results = {
    extract: {
      fullOutput: "FULL",
      status: "complete",
      summary: "SUMMARY",
      artifacts: "<a>X</a>",
      files: "a.ts, b.ts",
      total: "42",
    },
  };

  it("resolves ${{task}}", () => {
    expect(expandTemplateVariables("t=${{task}}", ctx({ task: "do-it" }))).toBe("t=do-it");
  });

  it("resolves ${{input.NAME}}", () => {
    expect(expandTemplateVariables("i=${{input.foo}}", ctx({ inputs: { foo: "BAR" } }))).toBe("i=BAR");
  });

  it("resolves ${{result.STEP}} to fullOutput", () => {
    expect(expandTemplateVariables("${{result.extract}}", ctx({ results }))).toBe("FULL");
  });

  it("resolves ${{result.STEP.summary}}", () => {
    expect(expandTemplateVariables("${{result.extract.summary}}", ctx({ results }))).toBe("SUMMARY");
  });

  it("resolves ${{result.STEP.status}}", () => {
    expect(expandTemplateVariables("${{result.extract.status}}", ctx({ results }))).toBe("complete");
  });

  it("resolves ${{result.STEP.artifacts}}", () => {
    expect(expandTemplateVariables("${{result.extract.artifacts}}", ctx({ results }))).toBe("<a>X</a>");
  });

  it("resolves ${{result.STEP.files}}", () => {
    expect(expandTemplateVariables("${{result.extract.files}}", ctx({ results }))).toBe("a.ts, b.ts");
  });

  it("resolves ${{result.STEP.<typedOutput>}} via the catch-all", () => {
    expect(expandTemplateVariables("${{result.extract.total}}", ctx({ results }))).toBe("42");
  });

  it("resolves ${{loop.STEP.iteration}} and ${{loop.STEP.max}}", () => {
    const c = ctx({ loopCounters: { verify: 2 }, loopMaxIterations: { verify: 3 } });
    expect(expandTemplateVariables("${{loop.verify.iteration}}/${{loop.verify.max}}", c)).toBe("2/3");
  });
});

describe("typed-output extraction → resolution, agent & code nodes (§1.2)", () => {
  it("resolves a typed output merged from an agent finish call", () => {
    const results: Record<string, any> = {};
    storeResult(results, "classify", {
      output: "raw",
      result: { status: "complete", summary: "s", artifacts: "", files: [] },
      typedOutputs: { verdict: "invoice" },
    });
    expect(expandTemplateVariables("${{result.classify.verdict}}", ctx({ results }))).toBe("invoice");
  });

  it("resolves a typed output produced by a code node return value", () => {
    const results: Record<string, any> = {};
    storeResult(results, "validate", {
      output: '{"valid":"true"}',
      result: { status: "complete", summary: "", artifacts: "", files: [] },
      typedOutputs: { valid: "true", nav_record: "NAV-1" },
    });
    expect(expandTemplateVariables("${{result.validate.valid}}|${{result.validate.nav_record}}", ctx({ results }))).toBe("true|NAV-1");
  });
});

describe("input-block resolution (§1.3)", () => {
  it("an input wired from an upstream result resolves, then ${{input.x}} reads it", () => {
    const results = { a: { fullOutput: "", status: "complete", summary: "UPSTREAM", artifacts: "", files: "" } };
    // Stage 1: resolve the inputs block value (as flow-execution does).
    const wired = expandTemplateVariables("${{result.a.summary}}", ctx({ results }));
    expect(wired).toBe("UPSTREAM");
    // Stage 2: the resolved value is exposed as ${{input.x}} to the step body.
    expect(expandTemplateVariables("x=${{input.x}}", ctx({ inputs: { x: wired } }))).toBe("x=UPSTREAM");
  });
});

describe("flow-ref result propagation (§1.4)", () => {
  it("a sub-flow step result flat-merged into the parent context is referenceable downstream", () => {
    // executeFlowRefStep flat-merges sub-flow step results into ctx.results.
    // Once merged, downstream resolution is identical to any other result.
    const results = { inner: { fullOutput: "", status: "complete", summary: "SUBFLOW", artifacts: "", files: "" } };
    expect(expandTemplateVariables("${{result.inner.summary}}", ctx({ results }))).toBe("SUBFLOW");
  });
});

describe("edge cases (§1.5)", () => {
  it("unresolved references expand to empty string (never undefined/omitted)", () => {
    expect(expandTemplateVariables("[${{result.missing.summary}}]", ctx())).toBe("[]");
    expect(expandTemplateVariables("[${{input.nope}}]", ctx())).toBe("[]");
    expect(expandTemplateVariables("[${{result.x.totl}}]", ctx())).toBe("[]");
  });

  it("an empty-but-present value resolves to empty string", () => {
    const results = { a: { fullOutput: "", status: "complete", summary: "", artifacts: "", files: "" } };
    expect(expandTemplateVariables("[${{result.a.summary}}]", ctx({ results }))).toBe("[]");
  });

  it("loop iteration is 1-based: an uninitialized counter resolves to 1, not 0", () => {
    // First body pass has no counter set yet → must read as 1 (harden-flow-wiring §4).
    expect(expandTemplateVariables("${{loop.verify.iteration}}", ctx())).toBe("1");
  });

  it("body and decision agree: same counter state yields the same iteration value", () => {
    const c = ctx({ loopCounters: { verify: 2 } });
    const bodyView = expandTemplateVariables("${{loop.verify.iteration}}", c);
    const decisionView = expandTemplateVariables("attempt ${{loop.verify.iteration}}", c);
    expect(bodyView).toBe("2");
    expect(decisionView).toBe("attempt 2");
  });
});
