/**
 * End-to-end style tests for code nodes (tasks 6.3, 7.1, 7.2).
 *
 * These exercise the seams a real flow run depends on without standing up the
 * full runFlow harness:
 *   - 6.3: flow_write's generation path (parse YAML string -> generate templates)
 *   - 7.1: a code node's typed output wires into a downstream `${{result.id.out}}`
 *   - 7.2: missing handler -> soft failure routes on_error; implemented -> success
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { executeCodeStep } from "../extensions/flow-engine/execute-code-step.js";
import { expandTemplateVariables } from "../extensions/flow-engine/execution.js";
import { resolveRouteOutcome } from "../extensions/flow-engine/failure.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { generateCodeHandlers } from "../extensions/flow-engine/flow-generate.js";
import type { CodeStep, AgentResult } from "../extensions/flow-engine/types.js";

function tempHandler(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const path = join(dir, "handler.mjs");
  writeFileSync(path, code, "utf8");
  return path;
}

/** Mirror flow-execution's storeResult merge so downstream template resolution matches runtime. */
function storeResult(results: Record<string, any>, stepId: string, result: AgentResult): void {
  results[stepId] = {
    fullOutput: result.output,
    status: result.result.status,
    summary: result.result.summary,
    artifacts: result.result.artifacts,
    files: result.result.files.map((f) => f.path).join(", "),
    outputs: result.typedOutputs ?? {},
  };
}

function makeCtx(results: Record<string, any> = {}) {
  return { task: "t", inputs: {}, results, loopCounters: {}, loopMaxIterations: {} };
}

// ── 6.3: flow_write generation path ───────────────────────────────────────────

describe("flow_write generation path (6.3)", () => {
  it("a saved flow YAML with a code node produces a .ts.default template", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fw-"));
    // Bundled layout: the flow is its own directory holding flow.yaml + handlers.
    const flowDir = join(root, ".pi", "flows", "flows", "research");
    mkdirSync(flowDir, { recursive: true });
    const yamlPath = join(flowDir, "flow.yaml");
    const yaml = [
      "name: research",
      "description: test flow",
      "steps:",
      "  - id: validate-nav",
      "    type: code",
      "    outputs:",
      "      - name: valid",
    ].join("\n");
    writeFileSync(yamlPath, yaml, "utf8");

    // Exactly what flow_write does on success:
    const flow = parseFlowYamlString(yaml, yamlPath);
    const gen = generateCodeHandlers(flow, yamlPath);

    const tpl = join(flowDir, "validate-nav.ts.default");
    expect(existsSync(tpl)).toBe(true);
    expect(gen.generated).toContain(tpl);
  });
});

// ── 7.1: typed output wires downstream ────────────────────────────────────────

describe("code node typed output wires into a downstream step (7.1)", () => {
  it("resolves ${{result.extract.canonical}} from a code node's typed output", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { canonical: "INV-2024-001" };
}
`);
    const step: CodeStep = { stepType: "code", id: "extract", target: handlerPath, outputs: [{ name: "canonical" }] };

    const results: Record<string, any> = {};
    const result = await executeCodeStep(step, makeCtx(results), { cwd: tmpdir() }, "research", "");
    storeResult(results, "extract", result);

    const downstream = expandTemplateVariables("invoice=${{result.extract.canonical}}", makeCtx(results));
    expect(downstream).toBe("invoice=INV-2024-001");
  });
});

// ── 7.2: missing vs implemented handler routing ───────────────────────────────

describe("missing handler routes on_error, implemented handler succeeds (7.2)", () => {
  it("missing handler -> soft failure that routes on_error", async () => {
    const missingStep: CodeStep = {
      stepType: "code",
      id: "validate",
      target: join(tmpdir(), "does-not-exist-" + Date.now() + ".mjs"),
      outputs: [],
      on_error: "park",
    };
    const result = await executeCodeStep(missingStep, makeCtx(), { cwd: tmpdir() }, "research", "");
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("soft");
    expect(result.output).toContain("not found");
    // With on_error set, the soft failure routes there (not a hard halt).
    expect(resolveRouteOutcome(result, missingStep.on_error)).toBe("soft");
  });

  it("implemented handler -> success routes on_complete", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) { return { valid: "true" }; }
`);
    const step: CodeStep = { stepType: "code", id: "validate", target: handlerPath, outputs: [{ name: "valid" }], on_error: "park", on_complete: "approve" };
    const result = await executeCodeStep(step, makeCtx(), { cwd: tmpdir() }, "research", "");
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(resolveRouteOutcome(result, step.on_error)).toBe("success");
  });
});
