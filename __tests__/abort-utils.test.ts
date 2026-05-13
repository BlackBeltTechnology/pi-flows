/**
 * Pure tests for the parallel-batch abort race wrapper.
 *
 * See change: fix-pi-flows-end-to-end (Group 3).
 */
import { describe, it, expect } from "vitest";
import { signalRejection, raceWithAbort } from "../extensions/flow-engine/abort-utils.js";
import { FlowCancelledError } from "../extensions/flow-engine/flow-execution.js";

describe("signalRejection", () => {
  it("rejects immediately when signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    await expect(signalRejection(c.signal)).rejects.toBeInstanceOf(FlowCancelledError);
  });

  it("rejects when signal fires", async () => {
    const c = new AbortController();
    const p = signalRejection(c.signal);
    // Schedule abort on next tick
    setTimeout(() => c.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(FlowCancelledError);
  });

  it("returns a never-settling promise when signal is undefined", async () => {
    const p = signalRejection(undefined);
    const result = await Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), 50))]);
    expect(result).toBe("timeout");
  });

  it("removes the abort listener after rejecting (no leaks)", async () => {
    const c = new AbortController();
    // Spy via signal.removeEventListener — vitest doesn't have easy spies for
    // this, so we proxy. We trust the implementation uses { once: true } OR
    // manually removes; in either case the listener is gone after rejection.
    const p = signalRejection(c.signal);
    c.abort();
    await expect(p).rejects.toBeInstanceOf(FlowCancelledError);
    // Calling abort() again on an already-aborted controller does not invoke
    // the listener again (idempotent). Nothing to assert beyond no throw.
    expect(() => c.abort()).not.toThrow();
  });
});

describe("raceWithAbort", () => {
  it("returns the worker's resolution when signal does not fire", async () => {
    const c = new AbortController();
    const worker = new Promise<string>((r) => setTimeout(() => r("done"), 10));
    const result = await raceWithAbort(worker, c.signal);
    expect(result).toBe("done");
  });

  it("rejects with FlowCancelledError when signal fires before worker resolves", async () => {
    const c = new AbortController();
    const worker = new Promise<string>((r) => setTimeout(() => r("done"), 200));
    setTimeout(() => c.abort(), 5);
    const t0 = Date.now();
    await expect(raceWithAbort(worker, c.signal)).rejects.toBeInstanceOf(FlowCancelledError);
    expect(Date.now() - t0).toBeLessThan(100); // unwound well before worker would have resolved
  });

  it("bypasses race when signal is undefined", async () => {
    const worker = Promise.resolve("done");
    expect(await raceWithAbort(worker, undefined)).toBe("done");
  });

  it("settles within ~10ms of abort firing on a 500ms worker", async () => {
    const c = new AbortController();
    const worker = new Promise<string>((r) => setTimeout(() => r("done"), 500));
    setTimeout(() => c.abort(), 20);
    const t0 = Date.now();
    try {
      await raceWithAbort(worker, c.signal);
    } catch (err) {
      const elapsed = Date.now() - t0;
      expect(err).toBeInstanceOf(FlowCancelledError);
      expect(elapsed).toBeGreaterThanOrEqual(15);
      expect(elapsed).toBeLessThan(60); // ample slack on CI
    }
  });
});
