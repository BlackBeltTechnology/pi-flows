/**
 * runFlow multi-step output wiring via the faux provider (task 3.1).
 * Spec: faux-model-testing → "Multi-step output wiring", "Per-agent response selection".
 */

import { describe, it, expect } from "vitest";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

describe("faux runFlow — multi-step output wiring", () => {
  it("a downstream step receives an upstream agent's declared output", async () => {
    const flow: FlowConfig = {
      name: "wiring",
      description: "two-step wiring",
      source: "<faux>",
      steps: [
        { stepType: "agent", id: "producer", agent: "producer", task: "produce a widget id" },
        {
          stepType: "agent",
          id: "consumer",
          agent: "consumer",
          task: "consume ${{result.producer.out}}",
          blockedBy: ["producer"],
        },
      ],
    };

    const agents = [
      makeAgent({ name: "producer", model: "faux/faux-1", outputs: [{ name: "out" }] }),
      makeAgent({ name: "consumer", model: "faux/faux-1" }),
    ];

    const result = await runFaux({
      flow,
      agents,
      responder: (taskText) =>
        /produce/.test(taskText)
          ? scriptFinish({ status: "complete", summary: "produced", out: "WIDGET-42" })
          // Echo the dispatched task so the test can see the resolved upstream value.
          : scriptFinish({ status: "complete", summary: `received: ${taskText}` }),
    });

    expect(result.results.producer.status).toBe("complete");
    expect(result.results.producer.out).toBe("WIDGET-42");
    expect(result.results.consumer.status).toBe("complete");
    expect(result.results.consumer.summary).toContain("WIDGET-42");
  });
});
