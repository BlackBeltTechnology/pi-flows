/**
 * spawnAgent failure-routing tests via the faux provider (task 2.4).
 * Spec: faux-model-testing → "Soft failure on agent-reported error finish",
 *                            "Hard failure on exhausted provider error".
 *
 * Outcome semantics are defined by `classifyAgentOutcome` (failure.ts):
 *   finish(status:"error")              -> soft (agent_finish_error)
 *   no finish + exhausted API error     -> hard (api_error)
 */

import { describe, it, expect } from "vitest";
import { spawnFaux, scriptFinish, scriptError } from "./faux-harness.js";

describe("faux spawnAgent — failure routing", () => {
  it("an agent error finish routes to a soft outcome", async () => {
    const { result } = await spawnFaux({
      responses: [scriptFinish({ status: "error", summary: "logical failure" })],
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("soft");
    expect(result.failureInfo?.source).toBe("agent_finish_error");
  });

  it("exhausted provider errors route to a hard outcome", async () => {
    // Initial turn + MAX_FINISH_RETRIES (2) stop-gate retries = 3 turns; all
    // error so no finish is ever latched and the queue drains.
    const { result } = await spawnFaux({
      responses: [scriptError("boom"), scriptError("boom"), scriptError("boom")],
    });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("hard");
    expect(result.failureInfo?.source).toBe("api_error");
  });
});
