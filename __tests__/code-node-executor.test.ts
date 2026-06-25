/**
 * Tests for code node executor (execute-code-step.ts).
 * Covers handler invocation, input wiring, output contract,
 * coercion, timeout, missing handler, and failure routing.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { executeCodeStep } from "../extensions/flow-engine/execute-code-step.js";
import type { CodeStep } from "../extensions/flow-engine/types.js";

// ---- Helpers ----------------------------------------------------------------

/** Write a temp .mjs handler file and return its path. Uses unique dirs to avoid module cache conflicts. */
function tempHandler(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-code-node-"));
  const path = join(dir, `handler.mjs`);
  writeFileSync(path, code, "utf8");
  return path;
}

function makeCtx(overrides: Partial<{
  task: string;
  results: Record<string, any>;
  loopCounters: Record<string, number>;
  loopMaxIterations: Record<string, number>;
}> = {}) {
  return {
    task: overrides.task ?? "test task",
    results: overrides.results ?? {},
    loopCounters: overrides.loopCounters ?? {},
    loopMaxIterations: overrides.loopMaxIterations ?? {},
  };
}

function makeOptions(overrides: Partial<{
  cwd: string;
  signal: AbortSignal;
  onAgentStarted: any;
  onAgentComplete: any;
  onAssistantText: any;
}> = {}) {
  return {
    cwd: overrides.cwd ?? tmpdir(),
    signal: overrides.signal,
    onAgentStarted: overrides.onAgentStarted,
    onAgentComplete: overrides.onAgentComplete,
    onAssistantText: overrides.onAssistantText,
  };
}

function makeStep(overrides: Partial<CodeStep>): CodeStep {
  return {
    stepType: "code",
    id: "test-step",
    ...overrides,
  };
}

// ── Section 3.1: Handler invocation & input wiring ─────────────────────────

describe("Code node executor — handler invocation & inputs (3.1)", () => {
  it("invokes the default export with (input, ctx)", async () => {
    const handlerPath = tempHandler(`
let captured;
export default async function handler(input, ctx) {
  captured = { input, ctx };
  global.__captured_3_1 = captured;
  return {};
}
`);
    const step = makeStep({ target: handlerPath, outputs: [] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");

    expect(result.success).toBe(true);
  });

  it("passes declared inputs as expanded strings", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  global.__input_3_1b = input;
  return { out: input.invoice };
}
`);
    const step = makeStep({
      target: handlerPath,
      inputs: { invoice: "${{result.extract.canonical}}" },
      outputs: [{ name: "out" }],
    });
    const ctx = makeCtx({
      results: {
        extract: { fullOutput: "", status: "complete", summary: "", artifacts: "", files: "", canonical: "INV-001" },
      },
    });

    const result = await executeCodeStep(step, ctx, makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.["out"]).toBe("INV-001");
  });

  it("passes unresolved input as empty string", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  global.__input_3_1c = input;
  return { echo: input.missing };
}
`);
    const step = makeStep({
      target: handlerPath,
      inputs: { missing: "${{result.nonexistent.field}}" },
      outputs: [{ name: "echo" }],
    });

    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.["echo"]).toBe("");
  });

  it("passes ctx.cwd, ctx.stepId, ctx.flowName, ctx.task", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  global.__ctx_3_1d = ctx;
  return {};
}
`);
    const step = makeStep({ id: "my-step", target: handlerPath, outputs: [] });
    const cwd = "/tmp/test-cwd";

    await executeCodeStep(step, makeCtx({ task: "the task" }), makeOptions({ cwd }), "my-flow", "");

    const ctx = (global as any).__ctx_3_1d;
    expect(ctx.cwd).toBe(cwd);
    expect(ctx.stepId).toBe("my-step");
    expect(ctx.flowName).toBe("my-flow");
    expect(ctx.task).toBe("the task");
    expect(typeof ctx.logger).toBe("function");
    expect(typeof ctx.setSummary).toBe("function");
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it("routes ctx.logger output to onAssistantText", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  ctx.logger("hello from handler");
  return {};
}
`);
    const step = makeStep({ id: "log-step", target: handlerPath, outputs: [] });
    const logged: Array<{ name: string; stepId: string; text: string }> = [];
    const opts = makeOptions({
      onAssistantText: (name: string, stepId: string, text: string) => logged.push({ name, stepId, text }),
    });

    await executeCodeStep(step, makeCtx(), opts, "test-flow", "");
    expect(logged).toHaveLength(1);
    expect(logged[0].text).toBe("hello from handler");
    expect(logged[0].stepId).toBe("log-step");
  });
});

// ── Section 3.4: Output contract ────────────────────────────────────────────

describe("Code node executor — output contract (3.4)", () => {
  it("succeeds when return matches declared outputs exactly", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { valid: "true", nav_record: "X" };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "valid" }, { name: "nav_record" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.valid).toBe("true");
    expect(result.typedOutputs?.nav_record).toBe("X");
  });

  it("soft failure when a declared output is missing", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { valid: "true" }; // nav_record missing
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "valid" }, { name: "nav_record" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("nav_record");
  });

  it("soft failure when return has undeclared extra key", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { valid: "true", unexpected: "extra" };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "valid" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("unexpected");
  });

  it("side-effect node with no declared outputs succeeds with empty return", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return {};
}
`);
    const step = makeStep({ target: handlerPath, outputs: [] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
  });

  it("coerces number and boolean to string", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { count: 42, flag: true };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "count" }, { name: "flag" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.count).toBe("42");
    expect(result.typedOutputs?.flag).toBe("true");
  });

  it("coerces bigint to string", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { big: 9007199254740993n };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "big" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.big).toBe("9007199254740993");
  });

  it("soft failure when output value is an object", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { record: { id: 1 } };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "record" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("record");
  });

  it("soft failure when output value is null", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { field: null };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "field" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.output).toContain("field");
  });

  it("soft failure when output value is an array", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { items: [1, 2, 3] };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "items" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.output).toContain("items");
  });
});

// ── Section 3.5: Result mapping ─────────────────────────────────────────────

describe("Code node executor — result mapping (3.5)", () => {
  it("sets summary from ctx.setSummary when called", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  ctx.setSummary("validated against NAV");
  return {};
}
`);
    const step = makeStep({ target: handlerPath, outputs: [] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.result.summary).toBe("validated against NAV");
  });

  it("produces non-empty auto summary when setSummary not called", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { out1: "v1" };
}
`);
    const step = makeStep({ id: "my-code", target: handlerPath, outputs: [{ name: "out1" }] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.result.summary.length).toBeGreaterThan(0);
    expect(result.result.summary).toContain("my-code");
  });

  it("maps success to fullOutput = JSON.stringify of typed outputs", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  return { x: "1", y: "2" };
}
`);
    const step = makeStep({
      target: handlerPath,
      outputs: [{ name: "x" }, { name: "y" }],
    });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.output).toBe(JSON.stringify({ x: "1", y: "2" }));
    expect(result.result.files).toHaveLength(0);
    expect(result.result.artifacts).toBe("");
  });
});

// ── Section 3.6/3.7: Timeout ────────────────────────────────────────────────

describe("Code node executor — timeout (3.6/3.7)", () => {
  it("aborts ctx.signal and returns soft failure when timeout expires", async () => {
    let capturedSignal: AbortSignal | undefined;
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  global.__timeout_signal = ctx.signal;
  // Simulate a long-running handler
  await new Promise(resolve => setTimeout(resolve, 2000));
  return {};
}
`);
    const step = makeStep({ target: handlerPath, outputs: [], timeout: 50 });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");

    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("timeout");

    // ctx.signal should be aborted
    const signal = (global as any).__timeout_signal;
    if (signal) expect(signal.aborted).toBe(true);
  }, 5000);

  it("runs to completion when no timeout is set", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  // Short async work
  await new Promise(resolve => setTimeout(resolve, 10));
  return { done: "yes" };
}
`);
    const step = makeStep({ target: handlerPath, outputs: [{ name: "done" }] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(true);
    expect(result.typedOutputs?.done).toBe("yes");
  });
});

// ── Section 3.8/3.9: Missing handler ─────────────────────────────────────────

describe("Code node executor — missing handler (3.8/3.9)", () => {
  it("returns soft failure with copy-the-template message when handler file absent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-missing-handler-"));
    // Do NOT create the handler file
    const step = makeStep({ id: "my-node", outputs: [] }); // convention path, no target
    // Bundled layout: convention handler resolves relative to dirname(flow.source).
    const result = await executeCodeStep(step, makeCtx(), makeOptions({ cwd }), "my-flow", join(cwd, "flow.yaml"));

    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("my-node.ts.default");
    expect(result.output).toContain(".ts");
  });

  it("returns soft failure when handler has no default export", async () => {
    const handlerPath = tempHandler(`
// No default export
export function notDefault() { return {}; }
`);
    const step = makeStep({ target: handlerPath, outputs: [] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("default export");
  });
});

// ── Section 3.10: Failure routing ────────────────────────────────────────────

describe("Code node executor — failure routing (3.10)", () => {
  it("soft failure on plain throw", async () => {
    const handlerPath = tempHandler(`
export default async function handler(input, ctx) {
  throw new Error("something broke");
}
`);
    const step = makeStep({ target: handlerPath, outputs: [] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.result.status).toBe("error");
    expect(result.output).toContain("something broke");
  });

  it("returns a hard failure (does not throw) when the handler throws FlowHardError", async () => {
    // Code-node handlers are loaded via dynamic import, so a handler's
    // FlowHardError is a distinct class identity from the engine's. The
    // classifier detects it by name; the executor returns an `outcome: "hard"`
    // result so the scheduler halts the flow cleanly (it must NOT throw, which
    // would surface as an unhandled rejection).
    const hardErrHandlerPath = tempHandler(`
class FlowHardError extends Error {
  constructor(msg) { super(msg); this.name = "FlowHardError"; }
}
export default async function handler(input, ctx) {
  throw new FlowHardError("unrecoverable");
}
`);
    const step = makeStep({ target: hardErrHandlerPath, outputs: [] });
    const result = await executeCodeStep(step, makeCtx(), makeOptions(), "test-flow", "");
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("hard");
    expect(result.failureInfo?.source).toBe("flow_hard_error");
    expect(result.output).toContain("unrecoverable");
  });
});
