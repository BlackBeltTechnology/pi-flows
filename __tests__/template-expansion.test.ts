// Wiring coverage for the template-expansion engine (harden-flow-wiring §1).
// expandTemplateVariables is the resolution layer every node's inputs/task flow
// through. These tests lock its behavior for all supported variable forms,
// typed-output resolution, input wiring, and edge cases.

import { describe, it, expect } from "vitest";
import { expandTemplateVariables, resolveCodeInput, serializeForText, coerceDeclaredOutput } from "../extensions/flow-engine/execution.js";
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
    outputs: result.typedOutputs ?? {},
  };
}

describe("expandTemplateVariables — all variable forms (§1.1)", () => {
  const results = {
    extract: {
      fullOutput: "FULL",
      status: "complete",
      summary: "SUMMARY",
      outputs: { total: "42" },
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
    const results = { a: { fullOutput: "", status: "complete", summary: "UPSTREAM", artifacts: "", files: "", outputs: {} } };
    // Stage 1: resolve the inputs block value (as flow-execution does).
    const wired = expandTemplateVariables("${{result.a.summary}}", ctx({ results }));
    expect(wired).toBe("UPSTREAM");
    // Stage 2: the resolved value is exposed as ${{input.x}} to the step body.
    expect(expandTemplateVariables("x=${{input.x}}", ctx({ inputs: { x: wired } }))).toBe("x=UPSTREAM");
  });
});

describe("edge cases (§1.5)", () => {
  it("unresolved references expand to empty string (never undefined/omitted)", () => {
    expect(expandTemplateVariables("[${{result.missing.summary}}]", ctx())).toBe("[]");
    expect(expandTemplateVariables("[${{input.nope}}]", ctx())).toBe("[]");
    expect(expandTemplateVariables("[${{result.x.totl}}]", ctx())).toBe("[]");
  });

  it("an empty-but-present value resolves to empty string", () => {
    const results = { a: { fullOutput: "", status: "complete", summary: "", artifacts: "", files: "", outputs: {} } };
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

describe("typed data plane — structured outputs, JIT serialization, typed code inputs (flow-typed-io-and-run-state)", () => {
  const results = {
    a: {
      fullOutput: "RAW", status: "complete", summary: "S", artifacts: "", files: "",
      outputs: { obj: { k: 1 }, arr: [1, 2], num: 92, flag: true, str: "hi" },
    },
  } as any;

  // serializeForText: the text-boundary rule
  it("serializeForText: strings pass through; non-strings → compact JSON; null/undefined → ''", () => {
    expect(serializeForText("hi")).toBe("hi");
    expect(serializeForText(92)).toBe("92");
    expect(serializeForText(true)).toBe("true");
    expect(serializeForText({ k: 1 })).toBe('{"k":1}');
    expect(serializeForText([1, 2])).toBe("[1,2]");
    expect(serializeForText(null)).toBe("");
    expect(serializeForText(undefined)).toBe("");
  });

  // §2: JIT serialization at the template boundary
  it("an object output interpolated into a template yields compact JSON", () => {
    expect(expandTemplateVariables("${{result.a.obj}}", ctx({ results }))).toBe('{"k":1}');
  });
  it("a string output interpolates verbatim", () => {
    expect(expandTemplateVariables("${{result.a.str}}", ctx({ results }))).toBe("hi");
  });

  // §1.5 / Option A: typed delivery to code-node inputs
  it("a whole-value reference delivers the TYPED value", () => {
    expect(resolveCodeInput("${{result.a.obj}}", ctx({ results }))).toEqual({ k: 1 });
    expect(resolveCodeInput("${{result.a.num}}", ctx({ results }))).toBe(92);
    expect(resolveCodeInput("${{result.a.flag}}", ctx({ results }))).toBe(true);
  });
  it("an embedded reference delivers a JIT-serialized STRING", () => {
    expect(resolveCodeInput("id=${{result.a.obj}}", ctx({ results }))).toBe('id={"k":1}');
  });
  it("whole-value standard fields resolve to their string meta", () => {
    expect(resolveCodeInput("${{result.a.status}}", ctx({ results }))).toBe("complete");
    expect(resolveCodeInput("${{result.a.summary}}", ctx({ results }))).toBe("S");
    expect(resolveCodeInput("${{result.a}}", ctx({ results }))).toBe("RAW");
  });

  // G4: declared agent output coercion to the real type
  it("coerceDeclaredOutput: a validated string is coerced to the declared type", () => {
    expect(coerceDeclaredOutput("92", "number")).toBe(92);
    expect(coerceDeclaredOutput("true", "boolean")).toBe(true);
    expect(coerceDeclaredOutput("false", "boolean")).toBe(false);
    expect(coerceDeclaredOutput("hi", "string")).toBe("hi");
    expect(coerceDeclaredOutput("hi", undefined)).toBe("hi");
    expect(coerceDeclaredOutput(92, "number")).toBe(92); // already typed → passthrough
    expect(coerceDeclaredOutput("NaN-ish", "number")).toBe("NaN-ish"); // unparseable → keep string
  });
});
