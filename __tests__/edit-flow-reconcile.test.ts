// Change-gated edit-flow tool reconciler (apply-editflow-setting-live §1).
//
// The reconciler is the piece invoked at each turn start (before_agent_start)
// and at session_start to bring the flow_agents/flow_write authoring tools in
// line with the current flows.editFlow value WITHOUT a session restart. It must
// only rebuild the active-tool set when the resolved value actually changed
// (change-gated), so unchanged turns do not trigger a redundant setActiveTools
// / system-prompt rebuild.

import { describe, it, expect } from "vitest";

import { makeEditFlowToolReconciler } from "../extensions/flow-engine/edit-flow-reconcile.js";

const EDIT_FLOW_TOOLS = ["flow_agents", "flow_write"];

/** A tiny stand-in for pi's active-tool registry. */
function mkTools(initial: string[] = ["read", "grep"]) {
  let active = [...initial];
  let setCalls = 0;
  return {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
      setCalls += 1;
    },
    get active() {
      return active;
    },
    get setCalls() {
      return setCalls;
    },
  };
}

function mkReconciler(tools: ReturnType<typeof mkTools>) {
  return makeEditFlowToolReconciler({
    getActiveTools: tools.getActiveTools,
    setActiveTools: tools.setActiveTools,
    editFlowTools: EDIT_FLOW_TOOLS,
  });
}

describe("makeEditFlowToolReconciler — change-gated tool reconcile (§1)", () => {
  it("1.1 enable picked up: reconcile(false) stays inactive, then reconcile(true) activates the tools", () => {
    const tools = mkTools();
    const reconcile = mkReconciler(tools);

    // session_start-equivalent seed with edit-mode off
    expect(reconcile(false)).toBe(true); // first call always applies (seeds cache)
    expect(tools.active).not.toContain("flow_agents");
    expect(tools.active).not.toContain("flow_write");

    // on-disk flip to true, picked up on the next turn
    expect(reconcile(true)).toBe(true);
    expect(tools.active).toContain("flow_agents");
    expect(tools.active).toContain("flow_write");
    // pre-existing tools preserved
    expect(tools.active).toEqual(expect.arrayContaining(["read", "grep"]));
  });

  it("1.2 disable picked up: from enabled, reconcile(false) removes the authoring tools", () => {
    const tools = mkTools();
    const reconcile = mkReconciler(tools);

    reconcile(true);
    expect(tools.active).toContain("flow_agents");

    expect(reconcile(false)).toBe(true);
    expect(tools.active).not.toContain("flow_agents");
    expect(tools.active).not.toContain("flow_write");
    expect(tools.active).toEqual(expect.arrayContaining(["read", "grep"]));
  });

  it("1.3 change-gated: an unchanged value returns false and does not call setActiveTools again", () => {
    const tools = mkTools();
    const reconcile = mkReconciler(tools);

    expect(reconcile(true)).toBe(true);
    const callsAfterFirst = tools.setCalls;

    // two more identical turns — must be no-ops
    expect(reconcile(true)).toBe(false);
    expect(reconcile(true)).toBe(false);
    expect(tools.setCalls).toBe(callsAfterFirst); // no redundant rebuild

    // and a real change still applies
    expect(reconcile(false)).toBe(true);
    expect(tools.setCalls).toBe(callsAfterFirst + 1);
  });

  it("does not duplicate the authoring tools when they are already active", () => {
    const tools = mkTools(["read", "flow_agents", "flow_write"]);
    const reconcile = mkReconciler(tools);

    reconcile(true);
    expect(tools.active.filter((t) => t === "flow_agents")).toHaveLength(1);
    expect(tools.active.filter((t) => t === "flow_write")).toHaveLength(1);
  });
});
