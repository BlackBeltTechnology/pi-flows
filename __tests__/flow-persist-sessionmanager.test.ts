/**
 * Regression tests for flow-event persistence against the REAL pi SessionManager
 * and context builder. Locks the two invariants the persist-flow-runs design relies on:
 *   1. flow-event custom entries persist (deferred-flush gate is sticky), survive cold reload.
 *   2. flow-event custom entries are EXCLUDED from the built LLM context (telemetry, not context),
 *      while message entries (including empty ones) are emitted verbatim — which is exactly why
 *      injecting an assistant message to force a flush is forbidden.
 *
 * See change: persist-flow-runs (flow-session-persistence spec).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FlowEventPersister } from "../extensions/flow-engine/flow-persist.js";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function diskLines(f: string | undefined): string[] {
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
}

// Minimal message literal — real AssistantMessage carries api/provider/model/usage,
// none of which matter for persistence/context-shape behavior under test.
function msg(role: "user" | "assistant", text: string): any {
  return { role, content: [{ type: "text", text }] };
}

function flowEvents(sm: any): any[] {
  return sm.getEntries().filter((e: any) => e.type === "custom" && e.customType === "flow-event");
}

// Assistant message carrying an unresolved tool_use (its tool_result not yet appended).
function toolUseMsg(id: string): any {
  return { role: "assistant", content: [{ type: "toolCall", id, name: "ib_rules", input: {} }] };
}

// Tool result message answering a prior tool_use.
function toolResultMsg(id: string): any {
  return { role: "toolResult", toolCallId: id, toolName: "ib_rules", content: [{ type: "text", text: "ok" }] };
}

function assistantMarkers(sm: any): any[] {
  return sm
    .getEntries()
    .filter((e: any) => e.type === "message" && e.message.role === "assistant" && String(e.message.content?.[0]?.text || "").startsWith("[flow]"));
}

describe("flow-event persistence (real SessionManager)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "flow-persist-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("buffers flow-events until the first assistant message, but keeps them in-memory", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    const file = sm.getSessionFile();
    for (let i = 0; i < 5; i++) {
      sm.appendCustomEntry("flow-event", { seq: i, eventType: "flow_tool_call", data: { i } });
    }
    // gate closed: nothing on disk yet
    expect(diskLines(file).length).toBe(0);
    // but in-memory (browser refresh / reconnect path via getEntries) has them all
    expect(flowEvents(sm).length).toBe(5);
  });

  it("flushes all buffered entries on first assistant message, then writes each later entry immediately (sticky gate)", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    const file = sm.getSessionFile();
    for (let i = 0; i < 5; i++) {
      sm.appendCustomEntry("flow-event", { seq: i, eventType: "flow_tool_call", data: { i } });
    }
    expect(diskLines(file).length).toBe(0);

    sm.appendMessage(msg("assistant", ""));
    // header + 5 buffered customs + the assistant message
    expect(diskLines(file).length).toBe(7);

    // sticky: subsequent flow-event is written to disk immediately (no extra trigger)
    sm.appendCustomEntry("flow-event", { seq: 5, eventType: "flow_complete", data: {} });
    expect(diskLines(file).length).toBe(8);
  });

  it("recovers all flow-events on cold reload and keeps the JSONL fully parseable", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    const file = sm.getSessionFile()!;
    for (let i = 0; i < 5; i++) {
      sm.appendCustomEntry("flow-event", { seq: i, eventType: "flow_tool_call", data: { i } });
    }
    sm.appendMessage(msg("assistant", ""));
    sm.appendCustomEntry("flow-event", { seq: 5, eventType: "flow_complete", data: {} });

    // integrity: no corrupted lines
    let bad = 0;
    for (const l of diskLines(file)) { try { JSON.parse(l); } catch { bad++; } }
    expect(bad).toBe(0);

    // cold reload
    const sm2 = SessionManager.open(file, dir);
    expect(flowEvents(sm2).length).toBe(6);
  });

  it("completion marker carries the flow outcome status + summary", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    const file = sm.getSessionFile()!;
    const piShim = { appendEntry: (t: string, d: unknown) => sm.appendCustomEntry(t, d) };
    const persister = new FlowEventPersister(piShim as any, () => sm);
    persister.emitCompletionMarker("demo", { status: "success", summary: "processed invoice X" });
    const sm2 = SessionManager.open(file, dir);
    const marker = sm2.getEntries().find((e: any) => e.type === "message" && e.message.role === "assistant");
    const text = (marker as any).message.content[0].text as string;
    expect(text).toContain("success");
    expect(text).toContain("processed invoice X");
  });

  it("persister + non-empty completion marker opens the gate so a flow-first run reaches disk and survives cold reload", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    const file = sm.getSessionFile()!;
    // pi.appendEntry routes to sessionManager.appendCustomEntry in real pi.
    const piShim = { appendEntry: (t: string, d: unknown) => sm.appendCustomEntry(t, d) };
    const persister = new FlowEventPersister(piShim as any, () => sm);

    // Flow-first session: flow_started buffers, nothing on disk yet.
    persister.persist("flow:flow-started", { flowName: "demo" });
    expect(diskLines(file).length).toBe(0);

    // START marker opens the sticky gate MID-FLOW → file exists immediately.
    persister.emitStartMarker("demo");
    const afterStart = diskLines(file).length;
    expect(afterStart).toBeGreaterThan(0);

    // Subsequent events now write to disk in real time (mid-run durability).
    persister.persist("flow:subagent-tool-call", { toolName: "read" });
    expect(diskLines(file).length).toBeGreaterThan(afterStart);
    persister.persist("flow:complete", { ok: true });
    persister.emitCompletionMarker("demo");

    // Cold reload recovers all flow-event entries.
    const sm2 = SessionManager.open(file, dir);
    const customs = sm2.getEntries().filter((e: any) => e.type === "custom" && e.customType === "flow-event");
    expect(customs.length).toBe(3);

    // Markers are non-empty assistant text blocks (empty text block would 400 on resume).
    const markers = sm2.getEntries().filter((e: any) => e.type === "message" && e.message.role === "assistant");
    expect(markers.length).toBe(2); // started + finished
    for (const m of markers) expect((m as any).message.content[0].text.length).toBeGreaterThan(0);
  });

  it("context builder: flow-event customs excluded; assistant messages (incl. empty text block) emitted verbatim — hence marker must be NON-EMPTY", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    sm.appendMessage(msg("user", "run the flow"));
    for (let i = 0; i < 3; i++) {
      sm.appendCustomEntry("flow-event", { seq: i, eventType: "flow_tool_call", data: { i } });
    }
    sm.appendMessage(msg("assistant", "")); // empty (flush-trigger shape)
    sm.appendCustomEntry("flow-event", { seq: 3, eventType: "flow_complete", data: {} });
    sm.appendMessage(msg("user", "thanks"));
    sm.appendMessage(msg("assistant", "done"));

    const ctx = sm.buildSessionContext();

    // 2 user + 2 assistant = 4 messages; the 4 flow-event customs are NOT in context
    expect(ctx.messages.length).toBe(4);
    expect(ctx.messages.every((m: any) => m.role !== "custom")).toBe(true);
    const serialized = JSON.stringify(ctx.messages);
    expect(serialized.includes("flow_tool_call")).toBe(false);
    expect(serialized.includes("flow_complete")).toBe(false);

    // the empty assistant message IS emitted verbatim → proves injecting one to force a flush
    // would pollute the parent's LLM context. Hence: never inject; use a context-safe flush.
    const hasEmptyAssistant = ctx.messages.some(
      (m: any) => m.role === "assistant" && JSON.stringify(m.content).includes('"text":""'),
    );
    expect(hasEmptyAssistant).toBe(true);
  });
});

// See change: fix-flow-marker-tool-result-ordering (flow-session-persistence spec).
// The marker must not splice between an assistant tool_use and its tool_result. It is
// gated on "session has no user message": headless flow-only sessions (no user msg) still
// get both markers; interactive/tool-launched sessions (user msg present) skip the marker.
describe("flow marker ordering guard (no-user-message gate)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "flow-marker-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const persisterFor = (sm: any) => new FlowEventPersister({ appendEntry: (t: string, d: unknown) => sm.appendCustomEntry(t, d) } as any, () => sm);

  it("skips the start marker when a flow launches from inside a tool call (session has a user message)", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    sm.appendMessage(msg("user", "add a rule"));
    sm.appendMessage(toolUseMsg("toolu_1")); // launching tool_use, result not yet appended
    persisterFor(sm).emitStartMarker("invoicebot:add-rule");
    expect(assistantMarkers(sm).length).toBe(0);
  });

  it("skips both markers in any session that has a user message", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    sm.appendMessage(msg("user", "run it"));
    sm.appendMessage(msg("assistant", "working"));
    const p = persisterFor(sm);
    p.emitStartMarker("demo");
    p.emitCompletionMarker("demo", { status: "success" });
    expect(assistantMarkers(sm).length).toBe(0);
  });

  it("headless flow-only session (no user message) still gets BOTH markers and opens the gate", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    const file = sm.getSessionFile()!;
    const p = persisterFor(sm);
    p.persist("flow:flow-started", { flowName: "demo" });
    expect(diskLines(file).length).toBe(0); // buffered
    p.emitStartMarker("demo");
    expect(diskLines(file).length).toBeGreaterThan(0); // gate opened
    p.persist("flow:complete", { ok: true });
    p.emitCompletionMarker("demo");
    expect(assistantMarkers(sm).length).toBe(2); // started + finished
  });

  it("regression: marker never interleaves between an assistant tool_use and its tool_result", () => {
    const sm = SessionManager.create(process.cwd(), dir);
    sm.appendMessage(msg("user", "add a rule"));
    sm.appendMessage(toolUseMsg("toolu_1")); // tool_use launches the flow
    const p = persisterFor(sm);
    // flow runs while the tool is unresolved: events buffer, start marker attempted
    p.persist("flow:flow-started", { flowName: "f" });
    p.emitStartMarker("f");
    p.persist("flow:complete", { ok: true });
    p.emitCompletionMarker("f");
    // tool finally returns → result appended
    sm.appendMessage(toolResultMsg("toolu_1"));
    sm.appendMessage(msg("user", "thanks"));

    const seq = sm.buildSessionContext().messages;
    for (let i = 0; i < seq.length; i++) {
      const m: any = seq[i];
      if (m.role === "assistant" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "toolCall" || c.type === "tool_use")) {
        const next: any = seq[i + 1];
        expect(next?.role).toBe("toolResult");
      }
    }
  });
});
