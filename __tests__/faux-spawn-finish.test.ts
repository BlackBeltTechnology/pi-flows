/**
 * spawnAgent finish-path tests via the faux provider (tasks 2.1).
 * Spec: faux-model-testing → "Finish happy path", "Finish retry and latch".
 */

import { describe, it, expect } from "vitest";
import { spawnFaux, scriptFinish } from "./faux-harness.js";

describe("faux spawnAgent — finish happy path", () => {
  it("a schema-valid finish yields success with wired output", async () => {
    const { result } = await spawnFaux({
      responses: [
        scriptFinish({
          status: "complete",
          summary: "did the thing",
          files: [{ path: "a.txt", action: "created" }],
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.result.status).toBe("complete");
    expect(result.result.summary).toBe("did the thing");
    expect(result.finishParams?.summary).toBe("did the thing");
  });
});

describe("faux spawnAgent — finish retry + first-correct-wins latch", () => {
  it("a malformed finish then a valid finish latches the correct result", async () => {
    const { result } = await spawnFaux({
      responses: [
        // Malformed: missing required `status`/`summary` → guard rejects → retry.
        scriptFinish({ status: undefined as any, summary: undefined as any }),
        scriptFinish({ status: "complete", summary: "second try is correct" }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.result.summary).toBe("second try is correct");
  });
});
