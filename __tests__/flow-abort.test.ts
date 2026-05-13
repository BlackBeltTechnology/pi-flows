/**
 * Integration-flavored test: 3 parallel mock agents that each take 500 ms;
 * fire AbortSignal after 50 ms; assert the race wrapper unwinds the
 * parent within 100 ms of the signal firing.
 *
 * This isn't a full runFlow() test (that requires the SDK + a real model
 * registry); it exercises the exact pattern flow-execution.ts uses to wrap
 * its parallel batch.
 *
 * See change: fix-pi-flows-end-to-end (Group 3, task 3.5).
 */
import { describe, it, expect } from "vitest";
import { raceWithAbort } from "../extensions/flow-engine/abort-utils.js";
import { FlowCancelledError } from "../extensions/flow-engine/flow-execution.js";

function mockAgent(durationMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("done"), durationMs);
    signal?.addEventListener(
      "abort",
      () => {
        // Real agents call session.abort() which cancels the underlying
        // stream. We simulate that by resolving with a sentinel quickly.
        clearTimeout(t);
        resolve("aborted");
      },
      { once: true },
    );
  });
}

describe("flow parallel-batch abort race", () => {
  it("parent unwinds within 100 ms when abort fires mid-batch", async () => {
    const controller = new AbortController();

    // 3 agents, each would take 500 ms if uninterrupted
    const batch = [
      mockAgent(500, controller.signal),
      mockAgent(500, controller.signal),
      mockAgent(500, controller.signal),
    ];

    setTimeout(() => controller.abort(), 50);

    const t0 = Date.now();
    let caught: unknown = null;
    try {
      await raceWithAbort(Promise.all(batch), controller.signal);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - t0;

    expect(caught).toBeInstanceOf(FlowCancelledError);
    // Parent must unwind within 100 ms of abort firing (abort scheduled at 50ms)
    expect(elapsed).toBeLessThan(150);
    // ...and must NOT have waited for the 500 ms worker
    expect(elapsed).toBeLessThan(500);
  });

  it("returns batch results normally when no abort fires", async () => {
    const controller = new AbortController();
    const batch = [mockAgent(10), mockAgent(15), mockAgent(20)];
    const results = await raceWithAbort(Promise.all(batch), controller.signal);
    expect(results).toEqual(["done", "done", "done"]);
  });

  it("handles already-aborted signal at entry", async () => {
    const controller = new AbortController();
    controller.abort();
    const batch = [mockAgent(500), mockAgent(500)];
    await expect(
      raceWithAbort(Promise.all(batch), controller.signal),
    ).rejects.toBeInstanceOf(FlowCancelledError);
  });
});
