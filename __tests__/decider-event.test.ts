/** Spec: classifier-decisions — flow:decision emit / persist / manager forwarding (6.1, 6.2). */
import { describe, expect, it, vi } from "vitest";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";
import { FLOW_EVENT_NAME_MAP } from "../extensions/flow-engine/flow-persist.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";

let captured: any;
vi.mock("../extensions/flow-engine/flow-execution.js", () => ({
  runFlow: vi.fn(async (opts: any) => {
    captured = opts;
    return { lastResult: undefined, results: {}, forks: {}, flowName: "f", stepCount: 0, totalDuration: 0, status: "success" };
  }),
}));

const event: DecisionEvent = {
  flowName: "ship", stepId: "gate", nodeKind: "agent-decision", consumerId: "pi-flows:ship:gate",
  chain: ["system-one", "agent"], routedBy: "agent", label: "done",
  attempts: [
    { entry: "system-one", outcome: "untrusted", label: "done", confidence: 0.6, mode: "shadow", trusted: false, agreed: true, latencyMs: 4 },
    { entry: "agent", outcome: "ok", label: "done", confidence: 1, trusted: true, latencyMs: 900 },
  ],
};

describe("flow:decision", () => {
  it("is mapped for persistence as flow_decision", () => {
    expect(FLOW_EVENT_NAME_MAP["flow:decision"]).toBe("flow_decision");
    expect(FLOW_EVENT_NAME_MAP["flow:auto-decision"]).toBe("flow_auto_decision");
  });

  it("EventEmitObserver emits it live and records flow_decision", () => {
    const emitted: Array<{ ch: string; data: any }> = [];
    const records: any[] = [];
    const pi = { events: { emit: (ch: string, data: any) => emitted.push({ ch, data }) }, appendEntry: (_t: string, r: any) => records.push(r) } as any;
    new EventEmitObserver(pi).onDecision(event);
    expect(emitted.find((e) => e.ch === "flow:decision")?.data).toMatchObject({ stepId: "gate", routedBy: "agent", attempts: event.attempts });
    expect(records.find((r) => r.eventType === "flow_decision")?.data.consumerId).toBe("pi-flows:ship:gate");
  });

  it("onAutoDecision still emits flow:auto-decision (+ confidence when given)", () => {
    const emitted: Array<{ ch: string; data: any }> = [];
    const pi = { events: { emit: (ch: string, data: any) => emitted.push({ ch, data }) } } as any;
    const obs = new EventEmitObserver(pi);
    obs.onAutoDecision("fk", "system-one", "yes", "next", { confidence: 0.9 });
    obs.onAutoDecision("fk", "agent", "yes", "next");
    const evs = emitted.filter((e) => e.ch === "flow:auto-decision");
    expect(evs[0].data).toMatchObject({ forkId: "fk", agentName: "system-one", confidence: 0.9 });
    expect(evs[1].data.confidence).toBeUndefined();
  });

  it("FlowManager forwards onDecision and passes decider settings + trust to runFlow", async () => {
    const { FlowManager } = await import("../extensions/flow-engine/flow-manager.js");
    const seen: DecisionEvent[] = [];
    const cfg: any = {
      getAgents: () => new Map(), getPi: () => ({}), getProjectRoot: () => "/p", getPkgRoot: () => "/k",
      getModelRegistry: () => undefined, getModelRuntime: () => undefined,
      getFlowsSettings: () => ({ modelFallback: "session", decider: { entries: ["system-one"] } }),
      isProjectTrusted: () => true,
      getSessionManager: () => undefined, getExtraAgentExtensions: () => [], getExtensionTools: () => [],
      getSkill: () => undefined, isAutonomous: () => false,
    };
    const io: any = { askUser: async () => ({ answer: "" }), notify: () => {} };
    const mgr = new FlowManager(cfg, io, [{ onDecision: (e: DecisionEvent) => seen.push(e) }]);
    await mgr.start({ flow: { name: "f", description: "d", steps: [], source: "<t>" }, flowName: "f", task: "t" });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured.decider).toEqual({ entries: ["system-one"] });
    expect(captured.projectTrusted).toBe(true);
    captured.onDecision(event);
    expect(seen).toEqual([event]);
  });
});
