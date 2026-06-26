// First-correct-finish-wins latch (change: latch-agent-finish-result).
//
// The latch is the order-independent core of the finish-capture contract. It is
// extracted as a pure helper precisely so the ordering-sensitive double-finish
// bug can be locked in a unit test without a live session (mirroring how
// classifyAgentOutcome is unit-tested). The session wiring in execution.ts is a
// thin adapter: start() on tool_execution_start, end()→abort() on
// tool_execution_end, and `latched` drives the stop-gate reminder loop.

import { describe, expect, it } from "vitest";
import { createFinishLatch } from "../extensions/flow-engine/finish-latch.js";

const GOOD = { status: "complete", summary: "ok", files: [], done: "not-done" };
const DUP = { status: "complete", summary: "dup", files: [], done: "done" };

describe("finish latch — duplicate finish in one assistant message (3.1)", () => {
  it("first correct finish wins despite the duplicate's error-end arriving first", () => {
    const latch = createFinishLatch();
    let aborts = 0;
    const abortIf = (toolCallId: string, isError: boolean) => {
      if (latch.end(toolCallId, isError)) aborts++;
    };

    // pi-agent-core parallel batch order: start#1, start#2, end#2(err), end#1(ok)
    latch.start("A", GOOD);
    latch.start("B", DUP);
    abortIf("B", true); // guard-blocked duplicate → error end, arrives first
    abortIf("A", false); // the real, successful finish

    expect(latch.latched).toBe(true);
    expect(latch.params).toEqual(GOOD); // duplicate did NOT clobber or clear it
    expect(aborts).toBe(1);
  });

  it("a later start event cannot overwrite an earlier call's captured args", () => {
    const latch = createFinishLatch();
    latch.start("A", GOOD);
    latch.start("B", DUP); // start#2 must not touch what end#1 will read
    latch.end("A", false);
    expect(latch.params).toEqual(GOOD);
  });
});

describe("finish latch — ignored after latch / abort once (3.2)", () => {
  it("a second finish end (success or error) after the latch is ignored", () => {
    const latch = createFinishLatch();
    let aborts = 0;
    const abortIf = (id: string, isError: boolean) => {
      if (latch.end(id, isError)) aborts++;
    };

    latch.start("A", GOOD);
    latch.start("B", DUP);
    abortIf("A", false); // latches
    abortIf("B", false); // duplicate success after latch — ignored
    abortIf("B", true); // duplicate error after latch — ignored

    expect(latch.params).toEqual(GOOD);
    expect(aborts).toBe(1); // abort fires exactly once
  });
});

describe("finish latch — malformed then correct (3.3)", () => {
  it("an error end does not latch; a later correct finish does", () => {
    const latch = createFinishLatch();
    let aborts = 0;
    const abortIf = (id: string, isError: boolean) => {
      if (latch.end(id, isError)) aborts++;
    };

    // turn 1: malformed finish (schema rejected → isError) — no latch, no abort
    latch.start("A", { status: "complete" });
    abortIf("A", true);
    expect(latch.latched).toBe(false);
    expect(latch.params).toBeUndefined();
    expect(aborts).toBe(0);

    // turn 2: model self-corrects with a valid finish — latches
    latch.start("B", GOOD);
    abortIf("B", false);
    expect(latch.latched).toBe(true);
    expect(latch.params).toEqual(GOOD);
    expect(aborts).toBe(1);
  });
});

describe("finish latch — never produces a correct finish (3.4)", () => {
  it("stays unlatched so the stop-gate keeps re-prompting / classifies SOFT", () => {
    const latch = createFinishLatch();
    // only malformed attempts
    latch.start("A", {});
    latch.end("A", true);
    latch.start("B", {});
    latch.end("B", true);
    expect(latch.latched).toBe(false); // stop-gate condition `!latched` stays true
    expect(latch.params).toBeUndefined(); // classifyAgentOutcome(undefined) → soft
  });

  it("an end for an unknown toolCallId never latches", () => {
    const latch = createFinishLatch();
    expect(latch.end("ghost", false)).toBe(false);
    expect(latch.latched).toBe(false);
  });
});

describe("finish latch — latched abort carries the result (3.5)", () => {
  it("after a latched abort, params is set so the user-abort branch is skipped", () => {
    // execution.ts tail guards user-abort with `aborted && !finishParams`.
    // A latch-triggered abort always leaves params set, so that branch is
    // correctly skipped and the step resolves from the latched result.
    const latch = createFinishLatch();
    latch.start("A", GOOD);
    const shouldAbort = latch.end("A", false);
    expect(shouldAbort).toBe(true);
    expect(latch.params).toBeDefined(); // `aborted && !finishParams` === false
  });
});
