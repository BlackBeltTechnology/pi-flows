/**
 * spawnAgent abort-mid-stream test via the faux provider (task 2.3).
 * Spec: faux-model-testing → "Abort mid-stream".
 */

import { describe, it, expect } from "vitest";
import { spawnFaux, scriptSlowText, scriptFinish } from "./faux-harness.js";

describe("faux spawnAgent — abort mid-stream", () => {
  it("aborting the signal during a slow stream yields a non-success aborted outcome", async () => {
    const ac = new AbortController();
    // A long text streamed at a low token rate guarantees the abort lands
    // mid-stream, before any finish could be reached.
    const big = "word ".repeat(400);
    const pending = spawnFaux({
      responses: [scriptSlowText(big), scriptFinish({ status: "complete", summary: "never reached" })],
      signal: ac.signal,
      tokensPerSecond: 50,
    });

    setTimeout(() => ac.abort(), 30);
    const { result } = await pending;

    expect(result.success).toBe(false);
    expect(result.result.summary).toMatch(/abort/i);
  });
});
