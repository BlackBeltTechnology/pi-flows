/**
 * Tests for bundle-flow-handlers: each flow is a self-contained directory
 * (.pi/flows/flows/<ns>/<name>/flow.yaml) whose code handlers live in the SAME
 * directory, resolved relative to dirname(flow.source). Clean break — the flat
 * <name>.yaml layout is no longer discovered.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect } from "vitest";

import { discoverAll } from "../extensions/flow-engine/discovery.js";
import { generateCodeHandlers } from "../extensions/flow-engine/flow-generate.js";
import { executeCodeStep } from "../extensions/flow-engine/execute-code-step.js";
import type { CodeStep, FlowConfig } from "../extensions/flow-engine/types.js";

const MIN_FLOW = "name: ignored\ndescription: d\nsteps:\n  - id: s\n    agent: a\n";

function makeCtx() {
  return { task: "t", results: {}, loopCounters: {}, loopMaxIterations: {} } as any;
}

// ── Group 1: discovery of the bundled layout ─────────────────────────────────

describe("discovery — bundled layout", () => {
  it("loads <ns>/<name>/flow.yaml, registers <ns>:<name>, sets source to flow.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bundle-"));
    const fdir = join(root, ".pi", "flows", "flows", "test", "capabilities");
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, "flow.yaml"), MIN_FLOW, "utf8");

    const res = discoverAll(root, root);
    expect(res.flows.has("test:capabilities")).toBe(true);
    expect(res.flows.get("test:capabilities")!.source).toBe(join(fdir, "flow.yaml"));
  });

  it("does NOT discover a flat <name>.yaml (clean break)", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bundle-"));
    const cdir = join(root, ".pi", "flows", "flows", "custom");
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, "legacy.yaml"), MIN_FLOW, "utf8");

    const res = discoverAll(root, root);
    expect(res.flows.has("custom:legacy")).toBe(false);
    expect(res.flows.has("legacy")).toBe(false);
  });
});

// ── Group 2: source-relative handler resolution ──────────────────────────────

describe("handler resolution — relative to the flow directory", () => {
  it("generator scaffolds <id>.ts.default into the flow's own directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bundle-gen-"));
    const yamlPath = join(dir, "flow.yaml");
    writeFileSync(yamlPath, MIN_FLOW, "utf8");
    const flow: FlowConfig = {
      name: "x:f", description: "", source: yamlPath,
      steps: [{ stepType: "code", id: "transform", outputs: [] } as CodeStep],
    };
    const gen = generateCodeHandlers(flow, yamlPath);
    expect(existsSync(join(dir, "transform.ts.default"))).toBe(true);
    expect(gen.generated).toContain(join(dir, "transform.ts.default"));
  });

  it("executor runs the convention handler from dirname(flow.source)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bundle-exec-"));
    const yamlPath = join(dir, "flow.yaml");
    writeFileSync(yamlPath, MIN_FLOW, "utf8");
    writeFileSync(join(dir, "transform.ts"), "export default async () => ({});", "utf8");

    const step: CodeStep = { stepType: "code", id: "transform", outputs: [] };
    const res = await executeCodeStep(step, makeCtx(), { cwd: dir } as any, "x:f", yamlPath);
    expect(res.success).toBe(true);
  });

  it("fails loudly when a convention node has neither target nor flow source", async () => {
    const step: CodeStep = { stepType: "code", id: "x", outputs: [] };
    const res = await executeCodeStep(step, makeCtx(), { cwd: tmpdir() } as any, "f", "");
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/source|target/i);
  });

  it("generator and executor agree on the path (regression: the drift bug)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bundle-agree-"));
    const yamlPath = join(dir, "flow.yaml");
    writeFileSync(yamlPath, MIN_FLOW, "utf8");
    const flow: FlowConfig = {
      name: "test:capabilities", description: "", source: yamlPath,
      steps: [{ stepType: "code", id: "transform", outputs: [] } as CodeStep],
    };
    const gen = generateCodeHandlers(flow, yamlPath);
    // The generated template sits next to where the executor resolves the real handler.
    const generatedReal = gen.generated[0].replace(/\.default$/, "");
    expect(dirname(generatedReal)).toBe(dirname(yamlPath));
    expect(generatedReal).toBe(join(dir, "transform.ts"));
  });
});
