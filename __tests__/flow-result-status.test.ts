/**
 * flow-auto-end-session — the flow result SHALL report status "success" on
 * successful completion. This is the precondition the auto-end terminal-status
 * gate depends on; it was previously left undefined on the happy path.
 */
import { describe, it, expect } from "vitest";
import { runFauxFlow, makeAgent, scriptFinish } from "./faux-harness.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

describe("FlowResult.status", () => {
  it("is 'success' when a flow completes successfully", async () => {
    const flow: FlowConfig = {
      name: "f",
      description: "d",
      source: "",
      steps: [{ stepType: "agent", id: "solo", agent: "solo" }],
    };
    const result = await runFauxFlow({
      flow,
      agents: [makeAgent({ name: "solo" })],
      responder: () => scriptFinish({ status: "complete", summary: "ok" }),
    });
    expect(result.status).toBe("success");
  });
});
