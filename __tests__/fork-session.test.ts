/**
 * Tests for `planAgentSession` — the pure fork/in-memory decision used by
 * spawnAgent (spec `agent-node`, change: enhance-agent-node-contract).
 *
 *   fork_session off            → in-memory
 *   fork_session on + main file → fork the operator's persisted session
 *   fork_session on + no file   → in-memory fallback (not persisted)
 */

import { describe, expect, it } from "vitest";
import { planAgentSession } from "../extensions/flow-engine/execution.js";

describe("planAgentSession", () => {
  it("fork_session off → in-memory (default behavior)", () => {
    expect(planAgentSession(false, "/sessions/main.jsonl")).toEqual({ mode: "in-memory" });
    expect(planAgentSession(undefined, "/sessions/main.jsonl")).toEqual({ mode: "in-memory" });
  });

  it("fork_session on + persisted main session → fork from its file", () => {
    expect(planAgentSession(true, "/sessions/main.jsonl")).toEqual({
      mode: "fork",
      file: "/sessions/main.jsonl",
    });
  });

  it("fork_session on + unpersisted main session → in-memory with a reason", () => {
    const plan = planAgentSession(true, undefined);
    expect(plan.mode).toBe("in-memory");
    expect((plan as { reason?: string }).reason).toMatch(/not persisted/);
  });
});
