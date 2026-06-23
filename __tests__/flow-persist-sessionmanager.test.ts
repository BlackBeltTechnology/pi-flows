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
