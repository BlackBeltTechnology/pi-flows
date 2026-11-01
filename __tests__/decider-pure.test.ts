/** Spec: classifier-decisions — resolveDecider, buildQuestion, isTrusted (2.1-2.3). */
import { describe, expect, it } from "vitest";
import { resolveDecider, parseDeciderSpec } from "../extensions/flow-engine/decider/chain.js";
import { buildQuestion } from "../extensions/flow-engine/decider/question.js";
import { isTrusted } from "../extensions/flow-engine/decider/trust.js";

describe("resolveDecider", () => {
  it("defaults to [agent], auto, 0.75", () => {
    expect(resolveDecider(undefined, undefined, undefined)).toEqual({ entries: ["agent"], trust: "auto", minConfidence: 0.75 });
  });
  it("precedence step → flow → settings for entries", () => {
    const settings = { entries: ["system-one", "agent"] };
    expect(resolveDecider({}, {}, settings).entries).toEqual(["system-one", "agent"]);
    expect(resolveDecider({}, { entries: ["a/b"] }, settings).entries).toEqual(["a/b"]);
    expect(resolveDecider({ entries: ["agent"] }, { entries: ["a/b"] }, settings).entries).toEqual(["agent"]);
  });
  it("trust fields resolve one by one", () => {
    const r = resolveDecider(
      { trust: "calibrated" },
      { entries: ["system-one"], minConfidence: 0.9, trust: "confidence" },
      { entries: ["agent"], minConfidence: 0.5 },
    );
    expect(r).toEqual({ entries: ["system-one"], trust: "calibrated", minConfidence: 0.9 });
  });
});

describe("parseDeciderSpec", () => {
  it("list, object, invalid", () => {
    expect(parseDeciderSpec(["a", "agent"])).toEqual({ entries: ["a", "agent"] });
    expect(parseDeciderSpec({ chain: ["agent"], trust: "confidence", min_confidence: 0.6 })).toEqual({ entries: ["agent"], trust: "confidence", minConfidence: 0.6 });
    expect(() => parseDeciderSpec("agent")).toThrow();
  });
});

describe("buildQuestion", () => {
  it("branch means become criteria; default state {task}", () => {
    const q = buildQuestion({
      branches: { done: "report", fix: "fixer" },
      branchMeans: { done: "No blocking issues", fix: "Blocking issue found" },
      task: "Review result",
    });
    expect(q.question).toEqual({ type: "choice", instructions: "Review result", criteria: { done: "No blocking issues", fix: "Blocking issue found" } });
    expect(q.state).toEqual({ task: "Review result" });
  });
  it("label is the criterion without means", () => {
    const q = buildQuestion({ branches: { a: "x", b: "y" }, task: "t" });
    expect(q.question.criteria).toEqual({ a: "a", b: "b" });
  });
  it("declared state replaces the default", () => {
    const q = buildQuestion({ branches: { a: "x" }, task: "t", declaredState: { review: "summary" } });
    expect(q.state).toEqual({ review: "summary" });
  });
  it("fork options are criteria; Other adds question + userText", () => {
    const q = buildQuestion({ branches: { yes: "n", no: "m" }, options: ["yes", "no"], question: "Ship?", task: "Ship?", userText: "ship it anyway" });
    expect(q.question.criteria).toEqual({ yes: "yes", no: "no" });
    expect(q.question.instructions).toBe("Ship?");
    expect(q.state).toEqual({ task: "Ship?", question: "Ship?", userText: "ship it anyway" });
  });
});

describe("isTrusted", () => {
  const p = (trust: any, minConfidence = 0.75) => ({ trust, minConfidence });
  it("calibrated needs enforce", () => {
    expect(isTrusted({ confidence: 0.99, mode: "shadow" }, p("calibrated"), false)).toBe(false);
    expect(isTrusted({ confidence: 0.1, mode: "enforce" }, p("calibrated"), true)).toBe(true);
    expect(isTrusted({ confidence: 0.99 }, p("calibrated"), false)).toBe(false);
  });
  it("confidence needs >= min", () => {
    expect(isTrusted({ confidence: 0.75 }, p("confidence"), false)).toBe(true);
    expect(isTrusted({ confidence: 0.6 }, p("confidence"), false)).toBe(false);
  });
  it("auto: calibration record → enforce required, else confidence", () => {
    expect(isTrusted({ confidence: 0.99, mode: "shadow" }, p("auto"), true)).toBe(false);
    expect(isTrusted({ confidence: 0.1, mode: "enforce" }, p("auto"), true)).toBe(true);
    expect(isTrusted({ confidence: 0.9, mode: "shadow" }, p("auto"), false)).toBe(true);
    expect(isTrusted({ confidence: 0.5 }, p("auto"), false)).toBe(false);
  });
});
