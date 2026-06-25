/**
 * Tests for surface-node-kind: a first-class NodeKind carried end-to-end.
 *
 * 1. Every node executor emits its nodeKind (code/code-decision here; agent
 *    family covered via the FlowManager forwarding + EventEmitObserver tests).
 * 2. FlowManager forwards the lifecycle `extra` (nodeKind) to observers — the
 *    regression guard for the historic silent drop at the fan-out seam.
 * 3. EventEmitObserver carries nodeKind (+ code target) onto the emitted
 *    flow:agent-started / flow:agent-complete payloads.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, describe, it, expect } from "vitest";

import { executeCodeStep } from "../extensions/flow-engine/execute-code-step.js";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";
import type { CodeStep, CodeDecisionStep, AgentResult } from "../extensions/flow-engine/types.js";

// runFlow is dynamically imported by FlowManager.start(); mock it to capture
// the options object so we can drive its lifecycle callbacks directly.
let capturedOptions: any;
vi.mock("../extensions/flow-engine/flow-execution.js", () => ({
  runFlow: vi.fn(async (opts: any) => {
    capturedOptions = opts;
    return {
      lastResult: undefined,
      results: {},
      forks: {},
      flowName: "f",
      stepCount: 0,
      totalDuration: 0,
      status: "complete",
    };
  }),
}));

// ---- Helpers ----------------------------------------------------------------

function tempHandler(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-node-kind-"));
  const path = join(dir, "handler.mjs");
  writeFileSync(path, code, "utf8");
  return path;
}

function makeCtx() {
  return {
    task: "t",
    results: {} as Record<string, any>,
    loopCounters: {} as Record<string, number>,
    loopMaxIterations: {} as Record<string, number>,
  };
}

const okResult: AgentResult = {
  success: true, output: "", stderr: "", exitCode: 0,
  result: { status: "complete", files: [], artifacts: "", summary: "" },
  toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
};

// ── Executor emits nodeKind + target (code / code-decision) ──────────────────

describe("Code executor emits nodeKind + target", () => {
  it("code node started/complete carry nodeKind='code' and resolved target", async () => {
    const handlerPath = tempHandler(`export default async () => ({});`);
    const step: CodeStep = { stepType: "code", id: "n", target: handlerPath, outputs: [] };
    const started: any[] = [];
    const completed: any[] = [];
    await executeCodeStep(step, makeCtx(), {
      cwd: tmpdir(),
      onAgentStarted: (_n: string, _s: string, _m: string | undefined, extra?: any) => started.push(extra),
      onAgentComplete: (_n: string, _s: string, _r: any, extra?: any) => completed.push(extra),
    } as any, "flow", "");

    expect(started[0]?.nodeKind).toBe("code");
    expect(started[0]?.target).toBe(handlerPath);
    expect(completed[0]?.nodeKind).toBe("code");
  });

  it("code-decision node carries nodeKind='code-decision'", async () => {
    const handlerPath = tempHandler(`export default async () => ({ branch: "a" });`);
    const step: CodeDecisionStep = {
      stepType: "code-decision", id: "d", target: handlerPath,
      branches: { a: "next" }, outputs: [],
    } as any;
    const started: any[] = [];
    await executeCodeStep(step, makeCtx(), {
      cwd: tmpdir(),
      onAgentStarted: (_n: string, _s: string, _m: string | undefined, extra?: any) => started.push(extra),
    } as any, "flow", "");

    expect(started[0]?.nodeKind).toBe("code-decision");
  });
});

// ── EventEmitObserver carries nodeKind onto flow:* payloads ──────────────────

describe("EventEmitObserver carries nodeKind", () => {
  function makeObs() {
    const emitted: Array<{ ch: string; data: any }> = [];
    const pi = { events: { emit: (ch: string, data: any) => emitted.push({ ch, data }) } } as any;
    return { obs: new EventEmitObserver(pi), emitted };
  }

  it("includes nodeKind on flow:agent-started for an agent node", () => {
    const { obs, emitted } = makeObs();
    obs.onAgentStarted("a", "s1", undefined, "model-x", { nodeKind: "agent" } as any);
    const ev = emitted.find(e => e.ch === "flow:agent-started");
    expect(ev?.data.nodeKind).toBe("agent");
  });

  it("includes nodeKind + target on flow:agent-started for a code node", () => {
    const { obs, emitted } = makeObs();
    obs.onAgentStarted("c", "c", undefined, undefined, { nodeKind: "code", target: "/abs/h.ts" } as any);
    const ev = emitted.find(e => e.ch === "flow:agent-started");
    expect(ev?.data.nodeKind).toBe("code");
    expect(ev?.data.target).toBe("/abs/h.ts");
  });

  it("includes nodeKind on flow:agent-complete", () => {
    const { obs, emitted } = makeObs();
    obs.onAgentComplete("a", "s1", okResult, { nodeKind: "agent" } as any);
    const ev = emitted.find(e => e.ch === "flow:agent-complete");
    expect(ev?.data.nodeKind).toBe("agent");
  });

  // Replay contract (our side): nodeKind must land in the persisted
  // FlowEventRecord.data so the dashboard's (cross-repo) reduceFlowEvent can
  // reconstruct the card TYPE, not just its timeline.
  it("persists nodeKind + target in the flow_agent_started record", () => {
    const records: Array<{ type: string; record: any }> = [];
    const pi = {
      events: { emit: () => {} },
      appendEntry: (type: string, record: any) => records.push({ type, record }),
    } as any;
    const obs = new EventEmitObserver(pi);
    obs.onAgentStarted("c", "c", undefined, undefined, { nodeKind: "code", target: "/abs/h.ts" } as any);
    const rec = records.find(r => r.record.eventType === "flow_agent_started");
    expect(rec?.record.data.nodeKind).toBe("code");
    expect(rec?.record.data.target).toBe("/abs/h.ts");
  });
});

// ── FlowManager forwards nodeKind to observers (regression: historic drop) ───

describe("FlowManager forwards nodeKind through the fan-out", () => {
  function makeConfig() {
    return {
      getAgents: () => new Map(),
      getPi: () => ({ events: { emit: () => {} } }),
      getProjectRoot: () => tmpdir(),
      getPkgRoot: () => tmpdir(),
      getAuthStorage: () => undefined,
      getModelRegistry: () => undefined,
      getSessionManager: () => undefined,
      getExtraAgentExtensions: () => [],
      getExtensionTools: () => [],
      isAutonomous: () => false,
      getSkillContent: () => undefined,
    } as any;
  }
  const ioAdapter = {
    askUser: async () => ({ answer: "" }),
    handleExtensionUIRequest: () => {},
  } as any;

  it("onAgentStarted/onAgentComplete relay extra.nodeKind to every observer", async () => {
    const { FlowManager } = await import("../extensions/flow-engine/flow-manager.js");
    const started: any[] = [];
    const completed: any[] = [];
    const observer = {
      onAgentStarted: (_n: string, _s: string, _c: any, _m: string | undefined, extra?: any) => started.push(extra),
      onAgentComplete: (_n: string, _s: string, _r: any, extra?: any) => completed.push(extra),
    };
    const fm = new FlowManager(makeConfig(), ioAdapter, [observer]);
    await fm.start({ flow: { name: "f", steps: [], source: "" } as any, flowName: "f", task: "t" });

    expect(capturedOptions).toBeTruthy();
    capturedOptions.onAgentStarted("agent-x", "s1", "model", { nodeKind: "agent" });
    capturedOptions.onAgentComplete("agent-x", "s1", okResult, { nodeKind: "agent" });

    expect(started[0]?.nodeKind).toBe("agent");
    expect(completed[0]?.nodeKind).toBe("agent");
  });
});
