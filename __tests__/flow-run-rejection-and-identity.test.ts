/**
 * report-flow-run-rejection-and-run-identity
 *
 * 1. Dispatch rejection is a TERMINAL, renderable payload on flow:complete —
 *    status:"rejected" + reason at a stable top-level path, byte-identical to
 *    the slash-command strings (shared builders), with `results` omitted and no
 *    runId. A consumer that never saw flow_started renders off status+reason.
 * 2. Run identity: FlowManager mints a runId, threads it to onFlowStarted, and
 *    stamps FlowResult.runId; EventEmitObserver stamps runId on every payload.
 * 3. Atomicity: two flow:run dispatches cannot start two concurrent runs — the
 *    check-to-assign is atomic, so the second start() throws "already running".
 */

import { vi, describe, it, expect } from "vitest";
import { tmpdir } from "node:os";

import {
  buildDispatchRejection,
  flowNotFoundMessage,
  flowAlreadyRunningMessage,
} from "../extensions/flow-engine/index.js";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";
import type { AgentResult } from "../extensions/flow-engine/types.js";

// runFlow is dynamically imported by FlowManager.start(); mock it so start()
// resolves deterministically without a real flow execution.
let capturedOptions: any;
vi.mock("../extensions/flow-engine/flow-execution.js", () => ({
  runFlow: vi.fn(async (opts: any) => {
    capturedOptions = opts;
    return {
      lastResult: undefined,
      results: {},
      forks: {},
      flowName: opts.flow?.name ?? "f",
      stepCount: 0,
      totalDuration: 0,
      status: "success",
    };
  }),
}));

const okResult: AgentResult = {
  success: true, output: "", stderr: "", exitCode: 0,
  result: { status: "complete", files: [], artifacts: "", summary: "" },
  toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
};

// ── 1. Dispatch rejection payload contract ───────────────────────────────────

describe("dispatch rejection payload (the invoice-UI / automation contract)", () => {
  it("carries status:'rejected' + top-level reason + flowName, mirrors reason into the summary", () => {
    const reason = flowAlreadyRunningMessage("invoicebot:process");
    const p = buildDispatchRejection("invoicebot:reconcile", reason) as any;

    // machine-readable outcome — distinct from a run "error"
    expect(p.status).toBe("rejected");
    // human-readable reason at a stable TOP-LEVEL path (keyed by chat-fold)
    expect(p.reason).toBe(reason);
    expect(p.flowName).toBe("invoicebot:reconcile");
    // mirrored where the automation runner's summarizeFlowResult reads it
    expect(p.lastResult.result.summary).toBe(reason);
    expect(p.lastResult.result.status).toBe("error");
  });

  it("omits `results` (so the post-flow summary guard skips) and carries no runId", () => {
    const p = buildDispatchRejection("x:y", "boom") as any;
    expect("results" in p).toBe(false); // !fr.results ⇒ flow-summary handler returns early
    expect("runId" in p).toBe(false);   // no run existed
  });

  it("reason builders are byte-identical to the slash-command strings", () => {
    expect(flowNotFoundMessage("a:b")).toBe(`Flow "a:b" no longer exists — it may have been deleted`);
    expect(flowAlreadyRunningMessage("a:b")).toBe(`A flow is already running (a:b)`);
  });
});

// ── 2 & 3. Run identity + atomicity via the FlowManager harness ──────────────

describe("FlowManager run identity + atomic single-run guard", () => {
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
      getSkill: () => undefined,
    } as any;
  }
  const ioAdapter = { askUser: async () => ({ answer: "" }), handleExtensionUIRequest: () => {} } as any;
  const flow = { name: "f", steps: [], source: "" } as any;

  it("mints a runId, delivers it to onFlowStarted, and stamps FlowResult.runId", async () => {
    const { FlowManager } = await import("../extensions/flow-engine/flow-manager.js");
    let startedRunId: string | undefined;
    let completeRunId: string | undefined;
    const observer = {
      onFlowStarted: (runId: string) => { startedRunId = runId; },
      onFlowComplete: (_n: string, result: any) => { completeRunId = result.runId; },
    };
    const fm = new FlowManager(makeConfig(), ioAdapter, [observer]);
    await fm.start({ flow, flowName: "f", task: "t" });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget promise settle

    expect(startedRunId).toBeTruthy();
    expect(completeRunId).toBe(startedRunId); // same id on start and on the completion result
  });

  it("mints a DIFFERENT runId for each sequential run", async () => {
    const { FlowManager } = await import("../extensions/flow-engine/flow-manager.js");
    const ids: string[] = [];
    const fm = new FlowManager(makeConfig(), ioAdapter, [{ onFlowStarted: (id: string) => ids.push(id) }]);
    await fm.start({ flow, flowName: "f", task: "t" });
    await new Promise((r) => setTimeout(r, 0));
    await fm.start({ flow, flowName: "f", task: "t" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("check-to-assign is atomic: a second dispatch before the first resolves is declined, not a second run", async () => {
    const { FlowManager } = await import("../extensions/flow-engine/flow-manager.js");
    const runFlowMock = (await import("../extensions/flow-engine/flow-execution.js")).runFlow as any;
    runFlowMock.mockClear();
    const fm = new FlowManager(makeConfig(), ioAdapter, []);

    // Do NOT await the first: it marks the run active synchronously (before its
    // first internal await), so the second start() must observe it and throw.
    const first = fm.start({ flow, flowName: "f", task: "t" });
    await expect(fm.start({ flow, flowName: "f", task: "t" })).rejects.toThrow(/already running/i);
    await first;
    await new Promise((r) => setTimeout(r, 0));

    expect(runFlowMock).toHaveBeenCalledTimes(1); // exactly one run
  });
});

// ── EventEmitObserver stamps runId on every emitted payload (headless) ───────

describe("EventEmitObserver stamps the run identity on live payloads", () => {
  function makeObs() {
    const emitted: Array<{ ch: string; data: any }> = [];
    const pi = { events: { emit: (ch: string, data: any) => emitted.push({ ch, data }) } } as any;
    return { obs: new EventEmitObserver(pi), emitted };
  }

  it("puts the onFlowStarted runId on flow-started and subsequent payloads", () => {
    const { obs, emitted } = makeObs();
    obs.onFlowStarted("R-1", "f", { name: "f", source: "", steps: [] } as any, "t");
    obs.onAgentStarted("a", "s1");
    obs.onAgentComplete("a", "s1", okResult);

    const started = emitted.find((e) => e.ch === "flow:flow-started");
    expect(started?.data.runId).toBe("R-1");
    for (const e of emitted) expect(e.data.runId).toBe("R-1");
  });
});
