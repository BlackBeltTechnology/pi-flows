/**
 * Pure tests for FlowEventPersister — the unit that owns the durable
 * flow-event session-entry contract consumed by the dashboard replay.
 *
 * See change: persist-flow-runs.
 */
import { describe, it, expect } from "vitest";
import {
  FlowEventPersister,
  FLOW_EVENT_ENTRY_TYPE,
  FLOW_EVENT_NAME_MAP,
} from "../extensions/flow-engine/flow-persist.js";

interface CapturedEntry {
  customType: string;
  data: any;
}

function fakePi(): { appendEntry: (t: string, d: any) => void; entries: CapturedEntry[] } {
  const entries: CapturedEntry[] = [];
  return {
    appendEntry: (customType: string, data: any) => {
      entries.push({ customType, data });
    },
    entries,
  };
}

describe("FlowEventPersister", () => {
  it("persists each event as a flow-event entry with mapped name, seq, payload (4.1)", () => {
    const pi = fakePi();
    const p = new FlowEventPersister(pi as any);

    p.persist("flow:flow-started", { flowName: "demo" });
    p.persist("flow:subagent-tool-call", { toolName: "read", input: { path: "x" } });
    p.persist("flow:complete", { ok: true });

    expect(pi.entries.map((e) => e.customType)).toEqual([
      FLOW_EVENT_ENTRY_TYPE,
      FLOW_EVENT_ENTRY_TYPE,
      FLOW_EVENT_ENTRY_TYPE,
    ]);
    const recs = pi.entries.map((e) => e.data);
    expect(recs.map((r) => r.eventType)).toEqual(["flow_started", "flow_tool_call", "flow_complete"]);
    expect(recs.map((r) => r.seq)).toEqual([0, 1, 2]);
    // Payload preserved verbatim (what the bridge would have forwarded).
    expect(recs[1].data).toEqual({ toolName: "read", input: { path: "x" } });
  });

  it("records the engine-supplied runId and shares it across the run", () => {
    const pi = fakePi();
    const p = new FlowEventPersister(pi as any);

    // The engine mints the run id (FlowManager.start) and EventEmitObserver
    // stamps it on every payload; the persister records the SUPPLIED id and no
    // longer self-mints on flow:flow-started.
    p.persist("flow:flow-started", { runId: "R1" });
    p.persist("flow:agent-started", { runId: "R1", agentName: "a" });
    p.persist("flow:complete", { runId: "R1" });

    expect(pi.entries.map((e) => e.data.flowRunId)).toEqual(["R1", "R1", "R1"]);
  });

  it("records a distinct runId when the engine supplies a new one", () => {
    const pi = fakePi();
    const p = new FlowEventPersister(pi as any);

    p.persist("flow:flow-started", { runId: "R1" });
    p.persist("flow:flow-started", { runId: "R2" });

    expect(pi.entries[0].data.flowRunId).toBe("R1");
    expect(pi.entries[1].data.flowRunId).toBe("R2");
  });

  it("produces strictly increasing seq across many events (4.2)", () => {
    const pi = fakePi();
    const p = new FlowEventPersister(pi as any);

    p.persist("flow:flow-started", {});
    for (let i = 0; i < 25; i++) p.persist("flow:assistant-text", { i });

    const seqs = pi.entries.map((e) => e.data.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("persists every timeline kind, not just tool calls (4.3)", () => {
    const pi = fakePi();
    const p = new FlowEventPersister(pi as any);

    p.persist("flow:flow-started", {});
    p.persist("flow:assistant-text", { text: "answer" });
    p.persist("flow:thinking-text", { text: "reason" });
    p.persist("flow:subagent-tool-call", { toolName: "x" });
    p.persist("flow:subagent-tool-result", { output: "y", isError: false });
    p.persist("flow:agent-error", { text: "boom" });

    expect(pi.entries.map((e) => e.data.eventType)).toEqual([
      "flow_started",
      "flow_assistant_text",
      "flow_thinking_text",
      "flow_tool_call",
      "flow_tool_result",
      "flow_agent_error",
    ]);
  });

  it("maps flow:agent-error and skips unmapped channels (4.4)", () => {
    const pi = fakePi();
    const p = new FlowEventPersister(pi as any);

    p.persist("flow:notify", { message: "hi" }); // not a run-state event
    p.persist("flow:architect-started", {}); // scoped out (separate lifecycle)
    p.persist("flow:agent-error", { agentName: "a", stepId: "s", text: "e" });

    expect(pi.entries.length).toBe(1);
    expect(pi.entries[0].data.eventType).toBe("flow_agent_error");
  });

  it("never throws into the live path when appendEntry fails (best-effort)", () => {
    const p = new FlowEventPersister({
      appendEntry: () => {
        throw new Error("disk full");
      },
    } as any);

    expect(() => p.persist("flow:complete", {})).not.toThrow();
  });

  it("name map only covers flow-run channels (architect excluded)", () => {
    const channels = Object.keys(FLOW_EVENT_NAME_MAP);
    expect(channels).toContain("flow:agent-error");
    expect(channels.some((c) => c.startsWith("flow:architect-"))).toBe(false);
  });

  it("emitStartMarker and emitCompletionMarker append NON-EMPTY assistant text blocks via sessionManager", () => {
    const appended: any[] = [];
    const sm = { appendMessage: (m: any) => appended.push(m) };
    const p = new FlowEventPersister(fakePi() as any, () => sm);

    p.emitStartMarker("demo");
    p.emitCompletionMarker("demo");

    expect(appended.length).toBe(2);
    for (const m of appended) {
      expect(m.role).toBe("assistant");
      // non-empty text block (empty text block 400s on Anthropic resume)
      expect(m.content[0].type).toBe("text");
      expect(m.content[0].text.length).toBeGreaterThan(0);
      expect(m.content[0].text).toContain("demo");
    }
    expect(appended[0].content[0].text).toContain("started");
    expect(appended[1].content[0].text).toContain("finished");
  });

  it("emitCompletionMarker is a no-op (no throw) when no sessionManager is wired", () => {
    const p = new FlowEventPersister(fakePi() as any);
    expect(() => p.emitCompletionMarker("demo")).not.toThrow();
  });

  it("emitCompletionMarker never throws when appendMessage fails (best-effort)", () => {
    const sm = { appendMessage: () => { throw new Error("boom"); } };
    const p = new FlowEventPersister(fakePi() as any, () => sm);
    expect(() => p.emitCompletionMarker("demo")).not.toThrow();
  });
});
