/**
 * spawnAgent anthropic-messages prefix test via the faux provider (task 2.5).
 * Spec: faux-model-testing → "Anthropic-messages prefix variant".
 *
 * When model.api === "anthropic-messages", spawnAgent prefixes tool names with
 * "mcp__flows__" so Anthropic's endpoint accepts them. The finish tool the
 * agent must call is therefore "mcp__flows__finish".
 */

import { describe, it, expect } from "vitest";
import { spawnFaux, scriptFinish } from "./faux-harness.js";

describe("faux spawnAgent — anthropic-messages tool prefix", () => {
  it("captures a finish under the mcp__flows__finish prefixed name", async () => {
    const { result, finishToolName } = await spawnFaux({
      modelApi: "anthropic-messages",
      responses: [
        scriptFinish({ status: "complete", summary: "prefixed finish" }, "mcp__flows__finish"),
      ],
    });

    expect(finishToolName).toBe("mcp__flows__finish");
    expect(result.success).toBe(true);
    expect(result.result.summary).toBe("prefixed finish");
  });
});
