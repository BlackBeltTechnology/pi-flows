/**
 * Tests for code node dispatch (lifecycle events) and typed-output resolution.
 * Typed outputs from a code node feed downstream steps and code-decision
 * presence handlers (the canonical replacement for the removed `conditional`).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { executeCodeStep } from "../extensions/flow-engine/execute-code-step.js";
import type { CodeStep } from "../extensions/flow-engine/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tempHandler(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-"));
  const path = join(dir, "handler.mjs");
  writeFileSync(path, code, "utf8");
  return path;
}

function makeCtx() {
  return {
    task: "test task",
    results: {} as Record<string, any>,
    loopCounters: {} as Record<string, number>,
    loopMaxIterations: {} as Record<string, number>,
  };
}

function makeStep(overrides: Partial<CodeStep>): CodeStep {
  return { stepType: "code", id: "test-step", ...overrides };
}

// ── 4.2/4.3: Lifecycle events ─────────────────────────────────────────────────

describe("Code node lifecycle events (4.2/4.3)", () => {
  it("fires onAgentStarted with name=id and kind='code'", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) { return {}; }
`);
    const step = makeStep({ id: "my-code-node", target: handlerPath, outputs: [] });

    const started: any[] = [];
    const opts = {
      cwd: tmpdir(),
      onAgentStarted: (name: string, stepId: string, model?: string, extra?: any) => {
        started.push({ name, stepId, model, extra });
      },
    };

    await executeCodeStep(step, makeCtx(), opts, "test-flow");
    expect(started).toHaveLength(1);
    expect(started[0].name).toBe("my-code-node");
    expect(started[0].stepId).toBe("my-code-node");
    expect(started[0].extra?.kind).toBe("code");
  });

  it("fires onAgentComplete with name=id, result, and kind='code'", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) { return { x: "1" }; }
`);
    const step = makeStep({ id: "my-code-node", target: handlerPath, outputs: [{ name: "x" }] });

    const completed: any[] = [];
    const opts = {
      cwd: tmpdir(),
      onAgentComplete: (name: string, stepId: string, result: any, extra?: any) => {
        completed.push({ name, stepId, result, extra });
      },
    };

    await executeCodeStep(step, makeCtx(), opts, "test-flow");
    expect(completed).toHaveLength(1);
    expect(completed[0].name).toBe("my-code-node");
    expect(completed[0].stepId).toBe("my-code-node");
    expect(completed[0].result.success).toBe(true);
    expect(completed[0].extra?.kind).toBe("code");
  });

  it("fires onAssistantText when handler calls ctx.logger", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  ctx.logger("line 1");
  ctx.logger("line 2");
  return {};
}
`);
    const step = makeStep({ id: "logger-node", target: handlerPath, outputs: [] });

    const texts: string[] = [];
    const opts = {
      cwd: tmpdir(),
      onAssistantText: (_name: string, _stepId: string, text: string) => texts.push(text),
    };

    await executeCodeStep(step, makeCtx(), opts, "test-flow");
    expect(texts).toEqual(["line 1", "line 2"]);
  });

  it("fires onAgentComplete even on soft failure", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  throw new Error("soft failure");
}
`);
    const step = makeStep({ id: "fail-node", target: handlerPath, outputs: [] });

    const completed: any[] = [];
    const opts = {
      cwd: tmpdir(),
      onAgentComplete: (name: string, stepId: string, result: any, extra?: any) => {
        completed.push({ name, stepId, result, extra });
      },
    };

    await executeCodeStep(step, makeCtx(), opts, "test-flow");
    expect(completed).toHaveLength(1);
    expect(completed[0].result.success).toBe(false);
    expect(completed[0].extra?.kind).toBe("code");
  });
});

// ── 4.4/4.5: Conditional typed-output resolution ────────────────────────────

describe("typed-output resolution", () => {
  // A code node's typed outputs land in the ctx.results map and become available
  // to downstream steps (and to a code-decision presence handler, the canonical
  // replacement for the removed `conditional` step).

  it("typed output from code node is available in results map", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { valid: "true", count: "42" };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "valid" }, { name: "count" }],
    });

    const result = await executeCodeStep(step, makeCtx(), { cwd: tmpdir() }, "test-flow");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.valid).toBe("true");
    expect(result.typedOutputs?.count).toBe("42");
    // fullOutput should be JSON stringified
    expect(result.output).toBe(JSON.stringify({ valid: "true", count: "42" }));
  });
});
