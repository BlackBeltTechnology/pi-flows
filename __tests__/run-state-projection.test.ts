/**
 * Run-state exposure (change: flow-typed-io-and-run-state, G7).
 * `projectRuns` derives per-node live status (running/finished) + run liveness
 * from the persisted flow-event stream. Read-only and total on malformed input.
 */

import { describe, it, expect } from "vitest";
import { projectRuns } from "../extensions/flow-engine/flow-persist.js";

function entry(eventType: string, data: unknown, flowRunId: string, seq: number) {
  return { customType: "flow-event", data: { seq, eventType, data, flowRunId } };
}

describe("projectRuns — run-state projection", () => {
  it("projects live per-node status (pending/running/finished) from the event stream", () => {
    const entries = [
      entry("flow_started", { flowName: "f", steps: [{ id: "a" }, { id: "b" }, { id: "c" }] }, "r1", 0),
      entry("flow_agent_started", { stepId: "a" }, "r1", 1),
      entry("flow_agent_complete", { stepId: "a", result: { status: "complete", summary: "done a" } }, "r1", 2),
      entry("flow_agent_started", { stepId: "b" }, "r1", 3),
    ];
    const runs = projectRuns(entries);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.flowName).toBe("f");
    expect(run.live).toBe(true);
    const byId = Object.fromEntries(run.nodes.map((n) => [n.stepId, n]));
    expect(byId.a.status).toBe("finished");
    expect(byId.a.resultStatus).toBe("complete");
    expect(byId.a.summary).toBe("done a");
    expect(byId.b.status).toBe("running");
    expect(byId.c.status).toBe("pending");
  });

  it("marks a run not-live after a flow_complete record", () => {
    const entries = [
      entry("flow_started", { flowName: "f" }, "r1", 0),
      entry("flow_agent_started", { stepId: "a" }, "r1", 1),
      entry("flow_agent_complete", { stepId: "a", result: { status: "complete" } }, "r1", 2),
      entry("flow_complete", {}, "r1", 3),
    ];
    expect(projectRuns(entries)[0].live).toBe(false);
  });

  it("re-running a node (loop) resets it to running", () => {
    const entries = [
      entry("flow_started", { flowName: "f" }, "r1", 0),
      entry("flow_agent_started", { stepId: "a" }, "r1", 1),
      entry("flow_agent_complete", { stepId: "a", result: { status: "complete" } }, "r1", 2),
      entry("flow_agent_started", { stepId: "a" }, "r1", 3),
    ];
    expect(projectRuns(entries)[0].nodes[0].status).toBe("running");
  });

  it("is total on malformed input", () => {
    expect(projectRuns(null)).toEqual([]);
    expect(projectRuns([{ customType: "other" }, "x", null])).toEqual([]);
  });
});
