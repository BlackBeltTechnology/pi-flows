/**
 * Tests for code-node handler generation (flow-generate.ts).
 * Covers .ts.default scaffold content, regeneration policy (always rewrite
 * template, never touch the real .ts, skip custom-target nodes), and textual
 * drift detection between the YAML and an existing real handler.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { renderScaffold, generateCodeHandlers } from "../extensions/flow-engine/flow-generate.js";
import type { CodeStep, FlowConfig } from "../extensions/flow-engine/types.js";

function codeStep(overrides: Partial<CodeStep>): CodeStep {
  return { stepType: "code", id: "validate-nav", ...overrides };
}

function flowWith(steps: CodeStep[], name = "research"): FlowConfig {
  return { name, description: "", steps, source: "test" };
}

/**
 * Create a temp project root with a BUNDLED flow directory and return its
 * `flow.yaml` path. Handlers are co-located, so `handlersDir === dirname(yamlPath)`.
 */
function tempFlow(name = "research"): { root: string; yamlPath: string; handlersDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-gen-"));
  const flowDir = join(root, ".pi", "flows", "flows", name);
  mkdirSync(flowDir, { recursive: true });
  const yamlPath = join(flowDir, "flow.yaml");
  writeFileSync(yamlPath, "name: " + name + "\n", "utf8");
  const handlersDir = flowDir; // co-located: dirname(yamlPath)
  return { root, yamlPath, handlersDir };
}

describe("renderScaffold", () => {
  it("reflects declared inputs and outputs with a default-export stub returning empty values", () => {
    const step = codeStep({
      inputs: { invoice: "${{result.extract.canonical}}" },
      outputs: [{ name: "valid" }, { name: "nav_record" }],
    });
    const out = renderScaffold(step);
    expect(out).toContain('import type { CodeNodeContext } from "@blackbelt-technology/pi-flows"');
    expect(out).toContain("interface Input { invoice: string }");
    expect(out).toContain("interface Output { valid: string; nav_record: string }");
    expect(out).toMatch(/export default async function/);
    // empty-value stub for each declared output
    expect(out).toContain('valid: ""');
    expect(out).toContain('nav_record: ""');
  });

  it("renders empty interfaces and an empty return for a side-effect-only node", () => {
    const out = renderScaffold(codeStep({ id: "notify", inputs: {}, outputs: [] }));
    expect(out).toContain("interface Input {}");
    expect(out).toContain("interface Output {}");
    expect(out).toMatch(/return \{\s*\}/);
  });
});

describe("generateCodeHandlers", () => {
  it("writes a .ts.default for each convention code node", () => {
    const { yamlPath, handlersDir } = tempFlow();
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "validate-nav", outputs: [{ name: "valid" }] })]),
      yamlPath,
    );
    const tpl = join(handlersDir, "validate-nav.ts.default");
    expect(existsSync(tpl)).toBe(true);
    expect(res.generated).toContain(tpl);
    expect(res.diagnostics).toHaveLength(0);
  });

  it("always rewrites the .ts.default and never touches the real .ts", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    const realPath = join(handlersDir, "validate-nav.ts");
    const realBody = "// hand-written, do not touch\nexport default async () => ({});\n";
    writeFileSync(realPath, realBody, "utf8");
    const tplPath = join(handlersDir, "validate-nav.ts.default");
    writeFileSync(tplPath, "stale template", "utf8");

    generateCodeHandlers(flowWith([codeStep({ id: "validate-nav", outputs: [{ name: "valid" }] })]), yamlPath);

    expect(readFileSync(realPath, "utf8")).toBe(realBody); // untouched
    expect(readFileSync(tplPath, "utf8")).not.toBe("stale template"); // rewritten
    expect(readFileSync(tplPath, "utf8")).toContain("interface Output { valid: string }");
  });

  it("does NOT generate a template for a custom target node", () => {
    const { yamlPath, handlersDir } = tempFlow();
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "shared", target: "./shared/nav.ts", outputs: [{ name: "valid" }] })]),
      yamlPath,
    );
    expect(existsSync(join(handlersDir, "shared.ts.default"))).toBe(false);
    expect(res.generated).toHaveLength(0);
  });

  it("emits a non-fatal warning when the real handler's Output interface drifts from the YAML", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    writeFileSync(
      join(handlersDir, "validate-nav.ts"),
      'interface Input { invoice: string }\ninterface Output { valid: string }\nexport default async () => ({ valid: "" });\n',
      "utf8",
    );
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "validate-nav", inputs: { invoice: "x" }, outputs: [{ name: "valid" }, { name: "nav_record" }] })]),
      yamlPath,
    );
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].severity).toBe("warning");
    expect(res.diagnostics[0].message).toContain("nav_record");
  });

  it("silently skips drift detection when the real handler has no interface blocks", () => {
    const { yamlPath, handlersDir } = tempFlow();
    mkdirSync(handlersDir, { recursive: true });
    writeFileSync(
      join(handlersDir, "validate-nav.ts"),
      'export default async (input, ctx) => ({ valid: "" });\n',
      "utf8",
    );
    const res = generateCodeHandlers(
      flowWith([codeStep({ id: "validate-nav", outputs: [{ name: "valid" }, { name: "nav_record" }] })]),
      yamlPath,
    );
    expect(res.diagnostics).toHaveLength(0);
  });
});
