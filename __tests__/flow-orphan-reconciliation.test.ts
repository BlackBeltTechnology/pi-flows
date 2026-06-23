/**
 * Tests for orphaned-flow reconciliation on resume / abort.
 *
 * See change: clear-orphaned-flow-on-resume.
 */
import { describe, it, expect } from "vitest";
import {
  findOrphanedRun,
  FlowEventPersister,
  FLOW_EVENT_ENTRY_TYPE,
} from "../extensions/flow-engine/flow-persist.js";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";

// Build a flow-event custom entry as getEntries() would return it.
function ev(seq: number, eventType: string, flowRunId: string, data: any = {}) {
  return { type: "custom", customType: FLOW_EVENT_ENTRY_TYPE, data: { seq, eventType, data, flowRunId } };
}

describe("findOrphanedRun (4.1)", () => {
  it("returns the run when it has no flow_complete", () => {
    const entries = [
      ev(0, "flow_started", "R1", { flowName: "demo" }),
      ev(1, "flow_agent_started", "R1"),
      ev(2, "flow_tool_call", "R1"),
    ];
    expect(findOrphanedRun(entries)).toEqual({ flowRunId: "R1", maxSeq: 2, flowName: "demo" });
  });

  it("returns null when the latest run has a flow_complete", () => {
    const entries = [
      ev(0, "flow_started", "R1", { flowName: "demo" }),
      ev(1, "flow_agent_started", "R1"),
      ev(2, "flow_complete", "R1"),
    ];
    expect(findOrphanedRun(entries)).toBeNull();
  });

  it("returns null when there are no flow-event entries", () => {
    expect(findOrphanedRun([{ type: "message", role: "user" }])).toBeNull();
    expect(findOrphanedRun([])).toBeNull();
    expect(findOrphanedRun(undefined)).toBeNull();
  });

  it("evaluates only the latest run; an earlier orphan does not surface", () => {
    const entries = [
      ev(0, "flow_started", "R1", { flowName: "first" }),
      // R1 never completed, but R2 is later and DID complete → not orphaned.
      ev(1, "flow_started", "R2", { flowName: "second" }),
      ev(2, "flow_complete", "R2"),
    ];
    expect(findOrphanedRun(entries)).toBeNull();
  });

  it("surfaces the latest run when it is the orphan, ignoring an earlier clean run", () => {
    const entries = [
      ev(0, "flow_started", "R1", { flowName: "first" }),
      ev(1, "flow_complete", "R1"),
      ev(2, "flow_started", "R2", { flowName: "second" }),
      ev(3, "flow_agent_started", "R2"),
    ];
    expect(findOrphanedRun(entries)).toEqual({ flowRunId: "R2", maxSeq: 3, flowName: "second" });
  });
});

function fakeObserver() {
  const emitted: Array<{ channel: string; data: any }> = [];
  const appended: Array<{ customType: string; data: any }> = [];
  const pi = {
    events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
    appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
  };
  const obs = new EventEmitObserver(pi as any);
  return { obs, emitted, appended };
}

describe("EventEmitObserver.reconcileOrphanedRun (4.2)", () => {
  it("emits flow:complete once and persists a flow_complete tagged with the orphan id", () => {
    const { obs, emitted, appended } = fakeObserver();
    obs.reconcileOrphanedRun({ flowRunId: "R1", maxSeq: 5, flowName: "demo" }, "session-close");

    const completes = emitted.filter((e) => e.channel === "flow:complete");
    expect(completes).toHaveLength(1);
    expect(completes[0].data.status).toBe("aborted");
    expect(completes[0].data.flowName).toBe("demo");

    const terminals = appended.filter((a) => a.data.eventType === "flow_complete");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].customType).toBe(FLOW_EVENT_ENTRY_TYPE);
    expect(terminals[0].data.flowRunId).toBe("R1");
  });

  it("seeds seq past the orphan's max so the terminal record sorts last (4.4)", () => {
    const { obs, appended } = fakeObserver();
    obs.reconcileOrphanedRun({ flowRunId: "R1", maxSeq: 5, flowName: "demo" }, "user-abort");
    const terminal = appended.find((a) => a.data.eventType === "flow_complete")!;
    expect(terminal.data.seq).toBeGreaterThan(5);
  });

  it("uses cause-specific summaries", () => {
    const a = fakeObserver();
    a.obs.reconcileOrphanedRun({ flowRunId: "R1", maxSeq: 1, flowName: "x" }, "session-close");
    expect(a.emitted[0].data.lastResult.result.summary).toMatch(/parent session closed/);

    const b = fakeObserver();
    b.obs.reconcileOrphanedRun({ flowRunId: "R1", maxSeq: 1, flowName: "x" }, "user-abort");
    expect(b.emitted[0].data.lastResult.result.summary).toMatch(/no live run/);
  });
});

describe("idempotency (4.3)", () => {
  it("a scan over entries that now include the synthesized flow_complete finds no orphan", () => {
    const { obs, appended } = fakeObserver();
    const before = [
      ev(0, "flow_started", "R1", { flowName: "demo" }),
      ev(1, "flow_agent_started", "R1"),
    ];
    const orphan = findOrphanedRun(before);
    expect(orphan).not.toBeNull();
    obs.reconcileOrphanedRun(orphan!, "session-close");

    // Reconstruct the entry list as it would look after the synthesized append.
    const terminal = appended.find((a) => a.data.eventType === "flow_complete")!;
    const after = [...before, { type: "custom", customType: terminal.customType, data: terminal.data }];
    expect(findOrphanedRun(after)).toBeNull();
  });
});

describe("flush-gate marker carries a resume-safe zero usage (swallow regression)", () => {
  // Capture the exact appendMessage payload the persister writes.
  function capturingPersister() {
    const messages: any[] = [];
    const sm = { appendMessage: (m: any) => messages.push(m) };
    const p = new FlowEventPersister({ appendEntry() {} } as any, () => sm);
    return { p, messages };
  }

  it("start/finished markers include a complete zero Usage (input/output/cacheRead/cacheWrite/totalTokens/cost)", () => {
    const { p, messages } = capturingPersister();
    p.emitStartMarker("demo");
    p.emitCompletionMarker("demo");
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.role).toBe("assistant");
      expect(m.content[0].text).not.toBe(""); // still a non-empty text block
      expect(m.usage).toEqual({
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
    }
  });

  it("the marker's usage makes pi's calculateContextTokens return 0 without throwing", () => {
    const { p, messages } = capturingPersister();
    p.emitStartMarker("demo");
    // This is the exact call pi makes on the next user send after resume
    // (agent-session.js _checkCompaction → calculateContextTokens(usage)).
    expect(() => calculateContextTokens(messages[0].usage)).not.toThrow();
    expect(calculateContextTokens(messages[0].usage)).toBe(0);
  });

  it("omitting usage would throw on totalTokens (documents the original bug)", () => {
    expect(() => calculateContextTokens(undefined as any)).toThrow();
  });
});

describe("FlowEventPersister.seedSeq (4.4)", () => {
  it("advances the counter; never rewinds", () => {
    const appended: any[] = [];
    const pi = { appendEntry: (_t: string, d: any) => appended.push(d) };
    const p = new FlowEventPersister(pi as any);
    p.seedSeq(10);
    p.persistTerminal("R1", {});
    expect(appended[0].seq).toBe(11);
    p.seedSeq(3); // below current → no rewind
    p.persistTerminal("R1", {});
    expect(appended[1].seq).toBe(12);
  });
});
