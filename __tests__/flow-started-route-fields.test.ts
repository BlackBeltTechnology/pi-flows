/**
 * flow:flow-started must carry on_error per step so external graph renderers
 * (pi-dashboard flows-plugin) can draw `route` edges for flows wired via
 * on_error routing rather than blockedBy. (on_complete was removed.)
 * See changes: fix-flow-ui-graph-zoom-summary, remove-on-complete-routing.
 */
import { describe, it, expect } from "vitest";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";

function makeObs() {
  const emitted: Array<{ ch: string; data: any }> = [];
  const pi = { events: { emit: (ch: string, data: any) => emitted.push({ ch, data }) } } as any;
  return { obs: new EventEmitObserver(pi), emitted };
}

describe("flow:flow-started routing fields", () => {
  it("serializes on_error onto each step", () => {
    const { obs, emitted } = makeObs();
    const flow = {
      name: "f",
      source: "",
      steps: [
        { id: "load-state", stepType: "code", on_error: "hold" },
        { id: "resume-gate", stepType: "code-decision", branches: { new: "intake" } },
      ],
    } as any;
    obs.onFlowStarted("run-x", "f", flow, "t");
    const ev = emitted.find(e => e.ch === "flow:flow-started");
    expect(ev).toBeTruthy();
    const steps = ev!.data.steps as any[];
    const loadState = steps.find(s => s.id === "load-state");
    expect(loadState.onError).toBe("hold");
    // A step with no routing keeps the field undefined (backward-compatible).
    const gate = steps.find(s => s.id === "resume-gate");
    expect(gate.onError).toBeUndefined();
  });
});
