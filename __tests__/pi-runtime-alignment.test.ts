/**
 * align-pi-runtime-to-0-84 — regression guard for the spawnAgent →
 * createAgentSession bootstrap contract under the current pi SDK.
 *
 * Spec: subagent-spawn → "spawnAgent supplies a complete ResourceLoader to
 * createAgentSession" and "spawnAgent supplies model/auth via the modelRuntime
 * option" (scenario "Faux spawn constructs and completes under the current
 * runtime").
 *
 * Intent (not mechanism): a faux, zero-network agent driven through the real
 * spawnAgent loop and scripted to finish successfully MUST construct its
 * session and report success. Before the alignment the session fails to
 * construct (the SDK invokes ResourceLoader methods the in-line loader lacks),
 * so the outcome is a session-creation error rather than success.
 */

import { describe, it, expect } from "vitest";
import { spawnFaux, scriptFinish } from "./faux-harness.js";

describe("pi runtime alignment — spawnAgent bootstrap", () => {
  it("faux spawn constructs its session and completes successfully", async () => {
    const { result } = await spawnFaux({
      responses: [scriptFinish({ status: "complete", summary: "aligned" })],
    });

    expect(result.success).toBe(true);
    expect(result.result.status).toBe("complete");
    expect(result.result.summary).toBe("aligned");
  });

  it("also completes on the anthropic-messages prefix path", async () => {
    const { result } = await spawnFaux({
      modelApi: "anthropic-messages",
      responses: [
        scriptFinish({ status: "complete", summary: "aligned-prefixed" }, "mcp__flows__finish"),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.result.summary).toBe("aligned-prefixed");
  });
});
