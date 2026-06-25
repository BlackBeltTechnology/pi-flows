/**
 * Template-generation coverage for BOTH generated node types and their edge
 * cases (flow-generate.ts). The existing code-node-generate.test.ts covers the
 * `code` happy paths; this file adds full `code-decision` scaffold + generation
 * coverage and the cross-cutting edge cases (input drift, combined drift, key
 * order, multi-node flows, non-generated step skip, branch-union variants).
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { renderScaffold, generateCodeHandlers } from "../extensions/flow-engine/flow-generate.js";
import type { CodeStep, CodeDecisionStep, FlowStep, FlowConfig } from "../extensions/flow-engine/types.js";

function codeStep(overrides: Partial<CodeStep>): CodeStep {
  return { stepType: "code", id: "c", ...overrides };
}
function codeDecisionStep(overrides: Partial<CodeDecisionStep>): CodeDecisionStep {
  return { stepType: "code-decision", id: "d", branches: {}, ...overrides };
}
function flowWith(steps: FlowStep[], name = "research"): FlowConfig {
  return { name, description: "", steps, source: "test" };
}
function tempFlow(name = "research"): { yamlPath: string; handlersDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-tplgen-"));
  const flowsDir = join(root, ".pi", "flows", "flows");
  mkdirSync(flowsDir, { recursive: true });
  const yamlPath = join(flowsDir, `${name}.yaml`);
  writeFileSync(yamlPath, "name: " + name + "\n", "utf8");
  return { yamlPath, handlersDir: join(root, ".pi", "flows", "handlers", name) };
}

// ── renderScaffold: code-decision type ─────────────────────────────────────

describe("renderScaffold — code-decision", () => {
  it("emits a Branch union from branch labels and a {branch: Branch} & Output return type", () => {
    const out = renderScaffold(codeDecisionStep({
      branches: { auto: "approve", review: "queue", exception: "park" },
      outputs: [{ name: "approvers" }],
    }));
    expect(out).toContain('type Branch = "auto" | "review" | "exception";');
    expect(out).toContain("interface Output { approvers: string }");
    expect(out).toContain("Promise<{ branch: Branch } & Output>");
    // return body uses the first branch label and includes data outputs
    expect(out).toMatch(/return \{ branch: "auto", approvers: "" \}/);
  });

  it("emits branch + no data when there are no outputs", () => {
    const out = renderScaffold(codeDecisionStep({ branches: { yes: "a", no: "b" } }));
    expect(out).toContain('type Branch = "yes" | "no";');
    expect(out).toContain("interface Output {}");
    expect(out).toMatch(/return \{ branch: "yes" \}/);
  });

  it("falls back to `type Branch = string` and empty branch when no branches declared", () => {
    const out = renderScaffold(codeDecisionStep({ branches: {} }));
    expect(out).toContain("type Branch = string;");
    expect(out).toMatch(/return \{ branch: "" \}/);
  });

  it("reflects declared inputs in the Input interface", () => {
    const out = renderScaffold(codeDecisionStep({
      inputs: { score: "${{result.recon.score}}" },
      branches: { pass: "x" },
    }));
    expect(out).toContain("interface Input { score: string }");
    expect(out).toContain('import type { CodeNodeContext } from "@blackbelt-technology/pi-flows"');
  });
});

// ── renderScaffold: code type edge cases not already covered ───────────────

describe("renderScaffold — code edge cases", () => {
  it("a plain code node has NO Branch union and a plain Output return type", () => {
    const out = renderScaffold(codeStep({ outputs: [{ name: "total" }] }));
    expect(out).not.toContain("type Branch");
    expect(out).not.toContain("branch:");
    expect(out).toContain("Promise<Output>");
    expect(out).toMatch(/return \{ total: "" \}/);
  });

  it("inputs-but-no-outputs renders an empty Output and empty return", () => {
    const out = renderScaffold(codeStep({ inputs: { x: "v" }, outputs: [] }));
    expect(out).toContain("interface Input { x: string }");
    expect(out).toContain("interface Output {}");
    expect(out).toMatch(/return \{\s*\}/);
  });
});

// ── generateCodeHandlers: code-decision generation ─────────────────────────

describe("generateCodeHandlers — code-decision", () => {
  it("writes a .ts.default for a code-decision node with the Branch union", () => {
    const { yamlPath, handlersDir } = tempFlow();
    const res = generateCodeHandlers(
      flowWith([codeDecisionStep({ id: "route", branches: { auto: "a", review: "b" } })]),
      yamlPath,
    );
    const tpl = join(handlersDir, "route.ts.default");
    expect(existsSync(tpl)).toBe(true);
    expect(res.generated).toContain(tpl);
    expect(readFileSync(tpl, "utf8")).toContain('type Branch = "auto" | "review";');
    expect(res.diagnostics).toHaveLength(0);
  });

  it("does NOT generate a template for a custom-target code-decision node", () => {
    const { yamlPath, handlersDir } = tempFlow();
    const res = generateCodeHandlers(
      flowWith([codeDecisionStep({ id: "route", target: "./shared/route.ts", branches: { a: "x" } })]),
      yamlPath,
    );
    expect(existsSync(join(handlersDir, "route.ts.default"))).toBe(false);
    expect(res.generated).toHaveLength(0);
  });

  it("detects output drift on a code-decision real handler (branch output is not a data output)", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    writeFileSync(
      join(handlersDir, "route.ts"),
      'interface Input {}\ninterface Output { approvers: string }\nexport default async () => ({ branch: "auto" });\n',
      "utf8",
    );
    const res = generateCodeHandlers(
      flowWith([codeDecisionStep({ id: "route", branches: { auto: "a" }, outputs: [{ name: "approvers" }, { name: "reason" }] })]),
      yamlPath,
    );
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].message).toContain("reason");
  });
});

// ── generateCodeHandlers: cross-cutting edge cases ─────────────────────────

describe("generateCodeHandlers — edge cases", () => {
  it("detects INPUT drift (existing file only tested output drift)", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    writeFileSync(
      join(handlersDir, "c.ts"),
      'interface Input { a: string }\ninterface Output {}\nexport default async () => ({});\n',
      "utf8",
    );
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "c", inputs: { a: "x", b: "y" }, outputs: [] })]),
      yamlPath,
    );
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].message).toContain("Input keys");
    expect(res.diagnostics[0].message).toContain("b");
  });

  it("reports BOTH input and output drift in a single diagnostic message", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    writeFileSync(
      join(handlersDir, "c.ts"),
      'interface Input { a: string }\ninterface Output { x: string }\nexport default async () => ({ x: "" });\n',
      "utf8",
    );
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "c", inputs: { a: "1", b: "2" }, outputs: [{ name: "x" }, { name: "y" }] })]),
      yamlPath,
    );
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].message).toContain("Input keys");
    expect(res.diagnostics[0].message).toContain("Output keys");
  });

  it("does NOT report drift when keys match but are in a different order", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    writeFileSync(
      join(handlersDir, "c.ts"),
      'interface Input {}\ninterface Output { b: string; a: string }\nexport default async () => ({ a: "", b: "" });\n',
      "utf8",
    );
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "c", outputs: [{ name: "a" }, { name: "b" }] })]),
      yamlPath,
    );
    expect(res.diagnostics).toHaveLength(0);
  });

  it("generates templates for every code/code-decision node in a mixed flow and skips non-generated steps", () => {
    const { yamlPath, handlersDir } = tempFlow();
    const res = generateCodeHandlers(
      flowWith([
        { stepType: "agent", id: "research", agent: "researcher" },
        codeStep({ id: "extract", outputs: [{ name: "canonical" }] }),
        codeDecisionStep({ id: "route", branches: { ok: "done", bad: "park" } }),
        { stepType: "fork", id: "ask", question: "?", options: ["a"], branches: { a: "done" } },
      ] as FlowStep[]),
      yamlPath,
    );
    expect(res.generated).toHaveLength(2);
    expect(existsSync(join(handlersDir, "extract.ts.default"))).toBe(true);
    expect(existsSync(join(handlersDir, "route.ts.default"))).toBe(true);
    // non-generated step types produce no template
    expect(existsSync(join(handlersDir, "research.ts.default"))).toBe(false);
    expect(existsSync(join(handlersDir, "ask.ts.default"))).toBe(false);
  });

  it("returns no templates and no diagnostics for a flow with no code/code-decision steps", () => {
    const { yamlPath } = tempFlow();
    const res = generateCodeHandlers(
      flowWith([{ stepType: "agent", id: "a", agent: "x" }] as FlowStep[]),
      yamlPath,
    );
    expect(res.generated).toHaveLength(0);
    expect(res.diagnostics).toHaveLength(0);
  });
});
