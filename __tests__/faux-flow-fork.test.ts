/**
 * runFlow parallel fan-in scheduling via the faux provider (task 3.2).
 * Spec: faux-model-testing → "Parallel fan-in scheduling".
 */

import { describe, it, expect } from "vitest";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

describe("faux runFlow — parallel fan-in", () => {
  it("two independent steps run and a third blocked by both completes after them", async () => {
    const flow: FlowConfig = {
      name: "fanin",
      description: "two parallel + join",
      source: "<faux>",
      max_concurrent: 2,
      steps: [
        { stepType: "agent", id: "a", agent: "worker", task: "branch A" },
        { stepType: "agent", id: "b", agent: "worker", task: "branch B" },
        { stepType: "agent", id: "c", agent: "worker", task: "join", blockedBy: ["a", "b"] },
      ],
    };

    const agents = [makeAgent({ name: "worker", model: "faux/faux-1" })];

    const result = await runFaux({
      flow,
      agents,
      // Echo the task so each step's identity is visible in its result.
      responder: (taskText) => scriptFinish({ status: "complete", summary: taskText }),
    });

    expect(result.results.a.status).toBe("complete");
    expect(result.results.b.status).toBe("complete");
    expect(result.results.c.status).toBe("complete");
    expect(result.results.a.summary).toContain("branch A");
    expect(result.results.b.summary).toContain("branch B");
    expect(result.results.c.summary).toContain("join");
  });
});
