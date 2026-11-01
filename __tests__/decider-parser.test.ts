/** Spec: classifier-decisions — parser + validator (tasks 1.1, 1.3). */
import { describe, expect, it } from "vitest";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";

const flow = (top: string, step: string) =>
  `name: f\ndescription: d\n${top}steps:\n${step}  - id: next\n    type: agent\n    agent: w\n  - id: other\n    type: agent\n    agent: w\n`;

const ad = (extra = "", branches = "      done: next\n      fix: other\n") =>
  `  - id: dec\n    type: agent-decision\n    task: t\n${extra}    branches:\n${branches}`;

describe("parser: decider / state / branch objects", () => {
  it("flow decider list form", () => {
    const f = parseFlowYamlString(flow("decider: [system-one, agent]\n", ad()), "<t>");
    expect(f.decider).toEqual({ entries: ["system-one", "agent"] });
  });
  it("step decider object form", () => {
    const f = parseFlowYamlString(
      flow("", ad("    decider:\n      chain: [typesafe/jev-latest, agent]\n      trust: confidence\n      min_confidence: 0.8\n")),
      "<t>",
    );
    expect((f.steps[0] as any).decider).toEqual({ entries: ["typesafe/jev-latest", "agent"], trust: "confidence", minConfidence: 0.8 });
  });
  it("state on agent-decision and fork", () => {
    const f = parseFlowYamlString(
      flow("", ad("    state:\n      review: ${{result.x.summary}}\n") +
        "  - id: fk\n    type: fork\n    question: q\n    options: [a, b]\n    state:\n      k: v\n    branches:\n      a: next\n      b: other\n"),
      "<t>",
    );
    expect((f.steps[0] as any).state).toEqual({ review: "${{result.x.summary}}" });
    expect((f.steps[1] as any).state).toEqual({ k: "v" });
  });
  it("{to, means} normalises to branches + branchMeans; string form unchanged", () => {
    const f = parseFlowYamlString(
      flow("", ad("", "      done: { to: next, means: \"No blocking issues\" }\n      fix: other\n")),
      "<t>",
    );
    const s = f.steps[0] as any;
    expect(s.branches).toEqual({ done: "next", fix: "other" });
    expect(s.branchMeans).toEqual({ done: "No blocking issues" });
  });
  it("no decider → undefined", () => {
    const f = parseFlowYamlString(flow("", ad()), "<t>");
    expect(f.decider).toBeUndefined();
    expect((f.steps[0] as any).branchMeans).toBeUndefined();
  });
  it("bad branch object (no to) throws", () => {
    expect(() => parseFlowYamlString(flow("", ad("", "      done: { means: x }\n      fix: other\n")), "<t>")).toThrow(/to/);
  });
});

describe("validator: decider", () => {
  const diags = (yaml: string, classifier?: (ref: string) => boolean) =>
    validateFlowContent(yaml, undefined, classifier).diagnostics;
  it("unknown entry is an error naming it and the allowed forms", () => {
    const d = diags(flow("decider: [magic]\n", ad())).filter((x) => x.severity === "error");
    expect(d.map((x) => x.message).join("\n")).toMatch(/magic/);
    expect(d.map((x) => x.message + (x.suggestion ?? "")).join("\n")).toMatch(/system-one/);
  });
  it("trust enum", () => {
    const d = diags(flow("decider:\n  chain: [agent]\n  trust: maybe\n", ad())).filter((x) => x.severity === "error");
    expect(d.some((x) => /trust/.test(x.message))).toBe(true);
  });
  it("min_confidence range", () => {
    const d = diags(flow("decider:\n  chain: [agent]\n  min_confidence: 1.5\n", ad())).filter((x) => x.severity === "error");
    expect(d.some((x) => /min_confidence/.test(x.message))).toBe(true);
  });
  it("warns for branches without means in classifier chains", () => {
    const d = diags(flow("decider: [system-one, agent]\n", ad("", "      done: { to: next, means: ok }\n      fix: other\n")));
    const w = d.filter((x) => x.severity === "warning" && /means/.test(x.message));
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("fix");
  });
  it("no warning for agent-only chain", () => {
    const d = diags(flow("", ad()));
    expect(d.some((x) => /means/.test(x.message))).toBe(false);
  });
  it("non-classifier provider/model ref is an error when a catalog is given", () => {
    const d = diags(flow("decider: [anthropic/claude-haiku-4-5, agent]\n", ad()), () => false).filter((x) => x.severity === "error");
    expect(d.some((x) => /not a classifier model/.test(x.message))).toBe(true);
  });
  it("known classifier ref passes", () => {
    const d = diags(flow("decider: [typesafe/jev-latest]\n", ad()), () => true).filter((x) => x.severity === "error");
    expect(d).toEqual([]);
  });
  it("fork allowCustom without agent is fine when a decider chain exists", () => {
    const fork = "  - id: fk\n    type: fork\n    question: q\n    options: [a, b]\n    allowCustom: true\n    branches:\n      a: next\n      b: other\n";
    const agents = () => new Map([["w", { name: "w" } as any]]);
    const noChain = validateFlowContent(flow("", fork), agents).diagnostics.filter((x) => x.severity === "error");
    expect(noChain.some((x) => /allowCustom/.test(x.message))).toBe(true);
    const chain = validateFlowContent(flow("decider: [system-one]\n", fork), agents).diagnostics.filter((x) => x.severity === "error");
    expect(chain.some((x) => /allowCustom/.test(x.message))).toBe(false);
  });
});
