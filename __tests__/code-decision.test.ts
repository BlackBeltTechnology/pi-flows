/**
 * Tests for the unify-decision-routing change:
 *   - 6.2 code-decision forward branch routing, branch + data outputs,
 *         off-map branch hard fail, reserved-name handling
 *   - 6.3 backward-edge loop with max_iterations cap (via runFlow),
 *         last-iteration output semantics
 *   - 6.4 validator errors (dangling target, single branch, missing
 *         max_iterations, `branch` data output)
 *   - 6.5 scaffold emits the correct `Branch` union; parser migration errors
 *         for removed types (conditional / agent-loop-decision)
 */

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { executeCodeStep } from "../extensions/flow-engine/execute-code-step.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { renderScaffold } from "../extensions/flow-engine/flow-generate.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { runFlow } from "../extensions/flow-engine/flow-execution.js";
import type { CodeDecisionStep } from "../extensions/flow-engine/types.js";

function tempHandler(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-cd-"));
  const path = join(dir, "handler.mjs");
  writeFileSync(path, code, "utf8");
  return path;
}

function makeCtx() {
  return { task: "t", inputs: {}, results: {} as Record<string, any>, loopCounters: {} as Record<string, number>, loopMaxIterations: {} as Record<string, number> };
}

// ── 6.2: code-decision execution + reserved branch ────────────────────────────

describe("code-decision reserved branch output (6.2)", () => {
  it("surfaces the chosen branch via finishParams.branch without declaring it as a data output", async () => {
    const handlerPath = tempHandler(`
export default async function (input, ctx) { return { branch: "needs_human" }; }
`);
    const step: CodeDecisionStep = {
      stepType: "code-decision",
      id: "route",
      target: handlerPath,
      branches: { needs_human: "human-approval", auto: "export" },
    };
    const result = await executeCodeStep(step, makeCtx(), { cwd: tmpdir() }, "f", "");
    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.finishParams?.branch).toBe("needs_human");
    // branch is NOT a declared data output, so typedOutputs stays empty
    expect(result.typedOutputs).toEqual({});
  });

  it("returns branch alongside declared data outputs", async () => {
    const handlerPath = tempHandler(`
export default async function (input, ctx) { return { branch: "auto_approve", approvers: "alice,bob" }; }
`);
    const step: CodeDecisionStep = {
      stepType: "code-decision",
      id: "route",
      target: handlerPath,
      branches: { auto_approve: "export", needs_human: "review" },
      outputs: [{ name: "approvers" }],
    };
    const result = await executeCodeStep(step, makeCtx(), { cwd: tmpdir() }, "f", "");
    expect(result.success).toBe(true);
    expect(result.finishParams?.branch).toBe("auto_approve");
    expect(result.typedOutputs?.approvers).toBe("alice,bob");
  });

  it("soft-fails naming the reserved branch when the handler omits it", async () => {
    const handlerPath = tempHandler(`
export default async function (input, ctx) { return { approvers: "alice" }; }
`);
    const step: CodeDecisionStep = {
      stepType: "code-decision",
      id: "route",
      target: handlerPath,
      branches: { a: "x", b: "y" },
      outputs: [{ name: "approvers" }],
    };
    const result = await executeCodeStep(step, makeCtx(), { cwd: tmpdir() }, "f", "");
    expect(result.success).toBe(false);
    expect(result.output).toContain("branch");
  });

  it("tags lifecycle events with kind='code-decision'", async () => {
    const handlerPath = tempHandler(`
export default async function (input, ctx) { return { branch: "a" }; }
`);
    const step: CodeDecisionStep = { stepType: "code-decision", id: "route", target: handlerPath, branches: { a: "x", b: "y" } };
    const kinds: string[] = [];
    await executeCodeStep(step, makeCtx(), {
      cwd: tmpdir(),
      onAgentStarted: (_n, _s, _m, extra) => kinds.push(extra?.nodeKind ?? ""),
      onAgentComplete: (_n, _s, _r, extra) => kinds.push(extra?.nodeKind ?? ""),
    }, "f", "");
    expect(kinds).toEqual(["code-decision", "code-decision"]);
  });
});

// ── 6.5: parser ───────────────────────────────────────────────────────────────

describe("parser: code-decision + removed-type migration errors (6.5)", () => {
  const base = ["name: f", "description: d", "steps:"];

  it("parses an explicit type: code-decision step", () => {
    const yaml = [...base,
      "  - id: route",
      "    type: code-decision",
      "    branches:",
      "      auto: export",
      "      manual: review",
    ].join("\n");
    const flow = parseFlowYamlString(yaml, "<t>");
    const step = flow.steps[0] as CodeDecisionStep;
    expect(step.stepType).toBe("code-decision");
    expect(step.branches).toEqual({ auto: "export", manual: "review" });
  });

  it("accepts max_iterations on agent-decision", () => {
    const yaml = [...base,
      "  - id: loop",
      "    type: agent-decision",
      "    agent: judge",
      "    task: decide",
      "    max_iterations: 3",
      "    branches:",
      "      rework: build",
      "      done: ship",
    ].join("\n");
    const flow = parseFlowYamlString(yaml, "<t>");
    expect((flow.steps[0] as any).max_iterations).toBe(3);
  });

  it("rejects type: conditional with a migration hint", () => {
    const yaml = [...base, "  - id: c", "    type: conditional", "    check: x.gaps", "    present: a", "    absent: b"].join("\n");
    expect(() => parseFlowYamlString(yaml, "<t>")).toThrow(/code-decision/);
  });

  it("rejects type: agent-loop-decision with a migration hint", () => {
    const yaml = [...base, "  - id: l", "    type: agent-loop-decision", "    agent: a", "    task: t", "    loop_target: x", "    exit_target: y", "    max_iterations: 2"].join("\n");
    expect(() => parseFlowYamlString(yaml, "<t>")).toThrow(/agent-decision/);
  });

  it("rejects an inferred conditional (check: shorthand) with a migration hint", () => {
    const yaml = [...base, "  - id: c", "    check: x.gaps", "    present: a", "    absent: b"].join("\n");
    expect(() => parseFlowYamlString(yaml, "<t>")).toThrow(/conditional/);
  });
});

// ── 6.5: scaffold generation ──────────────────────────────────────────────────

describe("scaffold: Branch union (6.5)", () => {
  it("emits a Branch union from branch labels and a { branch: Branch } & Output return", () => {
    const step: CodeDecisionStep = {
      stepType: "code-decision",
      id: "route",
      branches: { auto_approve: "export", needs_human: "review", park: "hold" },
      outputs: [{ name: "approvers" }],
    };
    const src = renderScaffold(step);
    expect(src).toContain('type Branch = "auto_approve" | "needs_human" | "park";');
    expect(src).toContain("Promise<{ branch: Branch } & Output>");
    expect(src).toContain('return { branch: "auto_approve", approvers: "" };');
  });
});

// ── 6.4: validation ───────────────────────────────────────────────────────────

describe("validation: branch routing (6.4)", () => {
  const head = ["name: f", "description: d", "steps:"];
  const msgs = (yaml: string) => validateFlowContent(yaml).diagnostics.filter(d => d.severity === "error").map(d => d.message);

  it("flags a dangling branch target", () => {
    const yaml = [...head,
      "  - id: route", "    type: code-decision", "    branches:", "      a: nowhere", "      b: end",
      "  - id: end", "    type: code",
    ].join("\n");
    expect(msgs(yaml).some(m => /branch "a" targets unknown step ID "nowhere"/.test(m))).toBe(true);
  });

  it("flags a *-decision with fewer than two branches", () => {
    const yaml = [...head,
      "  - id: route", "    type: code-decision", "    branches:", "      only: end",
      "  - id: end", "    type: code",
    ].join("\n");
    expect(msgs(yaml).some(m => /at least 2/.test(m))).toBe(true);
  });

  it("flags a reserved `branch` data output", () => {
    const yaml = [...head,
      "  - id: route", "    type: code-decision", "    outputs:", "      - name: branch", "    branches:", "      a: end", "      b: end",
      "  - id: end", "    type: code",
    ].join("\n");
    expect(msgs(yaml).some(m => /reserved for routing/.test(m))).toBe(true);
  });

  it("flags a backward (loop) edge without max_iterations", () => {
    const yaml = [...head,
      "  - id: build", "    type: code",
      "  - id: route", "    type: code-decision", "    branches:", "      rework: build", "      done: ship",
      "  - id: ship", "    type: code",
    ].join("\n");
    expect(msgs(yaml).some(m => /backward edge.*no max_iterations|no max_iterations/.test(m))).toBe(true);
  });

  it("accepts a backward edge when max_iterations is declared", () => {
    const yaml = [...head,
      "  - id: build", "    type: code",
      "  - id: route", "    type: code-decision", "    max_iterations: 3", "    branches:", "      rework: build", "      done: ship",
      "  - id: ship", "    type: code",
    ].join("\n");
    expect(msgs(yaml).some(m => /max_iterations/.test(m))).toBe(false);
  });
});

// ── 6.2 / 6.3: routing + loop semantics via runFlow ───────────────────────────

function writeFlowAndHandlers(root: string) {
  const handler = (body: string) => {
    const p = join(root, `${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body, "utf8");
    return p;
  };
  return { handler };
}

function baseOptions(flow: any, cwd: string, loopEvents: any[]) {
  return {
    flow,
    task: "t",
    cwd,
    pi: {} as any,
    getAgent: () => undefined,
    askUser: async () => ({ answer: "" }),
    onLoopIteration: (stepId: string, iteration: number, maxIterations: number, loopTarget?: string) =>
      loopEvents.push({ stepId, iteration, maxIterations, loopTarget }),
  } as any;
}

describe("code-decision routing + loops via runFlow (6.2/6.3)", () => {
  it("loops a backward edge until max_iterations forces exit; outputs settle to the last iteration", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-loop-"));
    const { handler } = writeFlowAndHandlers(root);

    // counter: increment a file each pass, output the new count
    const counter = handler(`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export default async function (input, ctx) {
  const f = join(ctx.cwd, "count.txt");
  const n = existsSync(f) ? parseInt(readFileSync(f, "utf8"), 10) : 0;
  const next = n + 1;
  writeFileSync(f, String(next));
  return { count: String(next) };
}`);
    // decide: always loop back (the cap is what stops it)
    const decide = handler(`export default async function () { return { branch: "again" }; }`);
    // finish: persist the last-iteration count it received
    const finish = handler(`
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default async function (input, ctx) {
  writeFileSync(join(ctx.cwd, "final.txt"), input.final);
  return {};
}`);

    const flow = {
      name: "loopflow",
      description: "d",
      source: "<t>",
      steps: [
        { stepType: "code", id: "counter", target: counter, outputs: [{ name: "count" }] },
        { stepType: "code-decision", id: "decide", target: decide, max_iterations: 3, branches: { again: "counter", done: "finish" } },
        { stepType: "code", id: "finish", target: finish, inputs: { final: "${{result.counter.count}}" }, outputs: [] },
      ],
    };

    const loopEvents: any[] = [];
    const result = await runFlow(baseOptions(flow, root, loopEvents));

    // 1 initial pass + 3 backward loops = counter ran 4 times
    expect(readFileSync(join(root, "count.txt"), "utf8")).toBe("4");
    // last-iteration output flowed downstream
    expect(readFileSync(join(root, "final.txt"), "utf8")).toBe("4");
    // exactly 3 loop-iteration events (the cap), counting 1..3
    expect(loopEvents.map(e => e.iteration)).toEqual([1, 2, 3]);
    expect(loopEvents.every(e => e.stepId === "decide" && e.maxIterations === 3)).toBe(true);
    expect(result.status).not.toBe("error");
  });

  it("takes a forward branch and exits before the cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fwd-"));
    const { handler } = writeFlowAndHandlers(root);

    const counter = handler(`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export default async function (input, ctx) {
  const f = join(ctx.cwd, "count.txt");
  const n = existsSync(f) ? parseInt(readFileSync(f, "utf8"), 10) : 0;
  const next = n + 1;
  writeFileSync(f, String(next));
  return { count: String(next) };
}`);
    // decide: loop while count < 2, else exit forward
    const decide = handler(`
import { readFileSync } from "node:fs";
import { join } from "node:path";
export default async function (input, ctx) {
  const n = parseInt(readFileSync(join(ctx.cwd, "count.txt"), "utf8"), 10);
  return { branch: n >= 2 ? "done" : "again" };
}`);
    const finish = handler(`export default async function () { return {}; }`);

    const flow = {
      name: "fwdflow",
      description: "d",
      source: "<t>",
      steps: [
        { stepType: "code", id: "counter", target: counter, outputs: [{ name: "count" }] },
        { stepType: "code-decision", id: "decide", target: decide, max_iterations: 5, branches: { again: "counter", done: "finish" } },
        { stepType: "code", id: "finish", target: finish, outputs: [] },
      ],
    };

    const loopEvents: any[] = [];
    const result = await runFlow(baseOptions(flow, root, loopEvents));

    // counter ran twice (pass 1 -> again, pass 2 -> done)
    expect(readFileSync(join(root, "count.txt"), "utf8")).toBe("2");
    // one backward loop taken before the forward exit
    expect(loopEvents.map(e => e.iteration)).toEqual([1]);
    expect(result.status).not.toBe("error");
  });

  it("hard-fails the flow on an off-map branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-offmap-"));
    const { handler } = writeFlowAndHandlers(root);
    const decide = handler(`export default async function () { return { branch: "maybe" }; }`);
    const finish = handler(`export default async function () { return {}; }`);

    const flow = {
      name: "offmap",
      description: "d",
      source: "<t>",
      steps: [
        { stepType: "code-decision", id: "decide", target: decide, branches: { yes: "finish", no: "finish" } },
        { stepType: "code", id: "finish", target: finish, outputs: [] },
      ],
    };

    const result = await runFlow(baseOptions(flow, root, []));
    expect(result.status).toBe("error");
    expect(result.lastResult.output).toMatch(/maybe/);
  });
});
