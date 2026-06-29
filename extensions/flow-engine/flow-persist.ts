// ---------------------------------------------------------------------------
// Flow event persistence
//
// Durably records the flow-run lifecycle event stream into the active pi
// session via pi.appendEntry, so a flow run survives /resume and dashboard
// reload. The dashboard's replay path re-forwards these entries (ordered by
// `seq`) into its existing, idempotent flow reducer to rebuild the card.
//
// Persistence is additive and best-effort: it never replaces, delays, or
// throws into the live `pi.events.emit` path. See
// openspec/changes/persist-flow-runs/design.md.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowEventRecord } from "./types.js";

// customType used for every persisted flow-run event entry.
export const FLOW_EVENT_ENTRY_TYPE = "flow-event";

// Raw `flow:*` channel name -> dashboard protocol event name. Mirrors the
// flow-run subset of pi-agent-dashboard's FLOW_EVENT_MAP. Only channels listed
// here are persisted; everything else (queries, architect lifecycle, UI-only
// events) is intentionally skipped.
export const FLOW_EVENT_NAME_MAP: Record<string, string> = {
  "flow:flow-started": "flow_started",
  "flow:agent-started": "flow_agent_started",
  "flow:agent-complete": "flow_agent_complete",
  "flow:assistant-text": "flow_assistant_text",
  "flow:thinking-text": "flow_thinking_text",
  "flow:subagent-tool-call": "flow_tool_call",
  "flow:subagent-tool-result": "flow_tool_result",
  "flow:auto-decision": "flow_auto_decision",
  "flow:loop-iteration": "flow_loop_iteration",
  "flow:agent-error": "flow_agent_error",
  "flow:complete": "flow_complete",
};

// Result of scanning persisted flow-event entries for an interrupted run.
export interface OrphanedRun {
  flowRunId: string;
  // Highest seq observed across ALL flow-event records (not just this run);
  // used to seed a resumed persister so new records sort after everything.
  maxSeq: number;
  // flowName from the run's flow_started record, when available.
  flowName: string;
}

// Scan persisted session entries for the most recent flow run that never
// reached a terminal `flow_complete` record (interrupted by parent-session
// close). Read-only and total: never throws. Returns null when no orphan.
//
// "Most recent run" = the flowRunId whose records reach the highest seq. A run
// is orphaned iff none of its records carry eventType `flow_complete`.
export function findOrphanedRun(entries: unknown): OrphanedRun | null {
  if (!Array.isArray(entries)) return null;
  let globalMaxSeq = -1;
  // Per-run aggregate: max seq seen, whether terminal, and flowName.
  const runs = new Map<string, { maxSeq: number; terminal: boolean; flowName: string }>();
  for (const entry of entries) {
    const e = entry as { customType?: string; data?: FlowEventRecord };
    if (!e || e.customType !== FLOW_EVENT_ENTRY_TYPE || !e.data) continue;
    const rec = e.data;
    if (typeof rec.seq === "number" && rec.seq > globalMaxSeq) globalMaxSeq = rec.seq;
    const runId = rec.flowRunId;
    if (!runId) continue;
    const agg = runs.get(runId) ?? { maxSeq: -1, terminal: false, flowName: "" };
    if (typeof rec.seq === "number" && rec.seq > agg.maxSeq) agg.maxSeq = rec.seq;
    if (rec.eventType === "flow_complete") agg.terminal = true;
    if (rec.eventType === "flow_started" && rec.data && typeof rec.data === "object") {
      const name = (rec.data as { flowName?: unknown }).flowName;
      if (typeof name === "string") agg.flowName = name;
    }
    runs.set(runId, agg);
  }
  if (runs.size === 0) return null;
  // Pick the latest run by max seq.
  let latestId = "";
  let latestSeq = -1;
  for (const [id, agg] of runs) {
    if (agg.maxSeq > latestSeq) { latestSeq = agg.maxSeq; latestId = id; }
  }
  const latest = runs.get(latestId)!;
  if (latest.terminal) return null;
  return { flowRunId: latestId, maxSeq: globalMaxSeq, flowName: latest.flowName };
}

// ---------------------------------------------------------------------------
// Run-state projection (read-only seam — change: flow-typed-io-and-run-state)
//
// Projects the persisted flow-event stream into per-run, per-node status for a
// read-only inspection seam. Derives `running`/`finished` from the
// agent-started/agent-complete records and run liveness from `flow_complete`.
// Produced typed values are NOT in the event stream (they live in the
// completed-run result JSON); the read tool merges them in for finished runs.
// Total and read-only: never throws, never mutates.
// ---------------------------------------------------------------------------

export interface ProjectedNode {
  stepId: string;
  status: "pending" | "running" | "finished";
  resultStatus?: string; // complete | error | blocked | skipped
  summary?: string;
}

export interface ProjectedRun {
  flowRunId: string;
  flowName: string;
  live: boolean; // true until a terminal flow_complete record
  nodes: ProjectedNode[]; // started/finished in event order, then pending in declared order
}

export function projectRuns(entries: unknown): ProjectedRun[] {
  if (!Array.isArray(entries)) return [];
  const runs = new Map<string, ProjectedRun & { _order: number; _nodes: Map<string, ProjectedNode>; _declared: string[] }>();
  let order = 0;
  for (const entry of entries) {
    const e = entry as { customType?: string; data?: FlowEventRecord };
    if (!e || e.customType !== FLOW_EVENT_ENTRY_TYPE || !e.data) continue;
    const rec = e.data;
    const runId = rec.flowRunId;
    if (!runId) continue;
    let run = runs.get(runId);
    if (!run) {
      run = { flowRunId: runId, flowName: "", live: true, nodes: [], _order: order++, _nodes: new Map(), _declared: [] };
      runs.set(runId, run);
    }
    const d = (rec.data ?? {}) as { flowName?: unknown; stepId?: unknown; steps?: unknown; result?: { status?: unknown; summary?: unknown } };
    switch (rec.eventType) {
      case "flow_started":
        if (typeof d.flowName === "string") run.flowName = d.flowName;
        if (Array.isArray(d.steps)) {
          run._declared = d.steps.map((s) => (s as { id?: unknown })?.id).filter((x): x is string => typeof x === "string");
        }
        break;
      case "flow_agent_started":
        if (typeof d.stepId === "string") {
          // (Re)entry: a loop re-runs a node, so reset it to running.
          run._nodes.set(d.stepId, { stepId: d.stepId, status: "running" });
        }
        break;
      case "flow_agent_complete":
        if (typeof d.stepId === "string") {
          const node: ProjectedNode = run._nodes.get(d.stepId) ?? { stepId: d.stepId, status: "finished" };
          node.status = "finished";
          const r = d.result;
          if (r && typeof r === "object") {
            if (typeof r.status === "string") node.resultStatus = r.status;
            if (typeof r.summary === "string") node.summary = r.summary;
          }
          run._nodes.set(d.stepId, node);
        }
        break;
      case "flow_complete":
        run.live = false;
        break;
    }
  }
  return [...runs.values()]
    .sort((a, b) => a._order - b._order)
    .map((r) => {
      const nodes = [...r._nodes.values()];
      const seen = new Set(nodes.map((n) => n.stepId));
      for (const id of r._declared) {
        if (!seen.has(id)) nodes.push({ stepId: id, status: "pending" });
      }
      return { flowRunId: r.flowRunId, flowName: r.flowName, live: r.live, nodes };
    });
}

// Records flow-run events into the pi session. Reusable: a follow-up change can
// add architect channels to FLOW_EVENT_NAME_MAP and reuse the same persister.
export class FlowEventPersister {
  private seq = 0;
  private flowRunId = "";

  constructor(
    private readonly pi: ExtensionAPI,
    // Lazy accessor for the main session's SessionManager (captured on
    // session_start). Used to open pi's flush gate via a marker message.
    private readonly getSessionManager?: () => any,
  ) {}

  // Append a NON-EMPTY assistant marker to the main session so pi's sticky
  // `hasAssistant` flush gate opens and buffered flow-event entries are written
  // to disk. The START marker opens the gate up front so the session file
  // exists for the WHOLE run — enabling mid-run stop+resume under the same id
  // and mid-run reload survival. The FINISHED marker reports completion status.
  // Both double as legitimate flow-status context for the managing model.
  //
  // MUST be a non-empty text block: the Anthropic API rejects an empty text
  // block (`[{type:"text",text:""}]`) with 400 on the next turn / resume
  // (verified against claude-haiku-4-5). Best-effort; never throws.
  //
  // MUST carry a well-formed zero `usage`: pi's _findLastAssistantMessage()
  // returns this marker on resume, and the next user send runs
  // _checkCompaction → calculateContextTokens(usage) (agent-session.js:1441),
  // which reads `usage.totalTokens` and crashes on `undefined`. That throw
  // rejects sendUserMessage and is swallowed by emitError, dropping the
  // user's message with no visible turn. A complete zero Usage (matching
  // pi-ai's Usage type incl. `cost`) makes calculateContextTokens return 0
  // (so shouldCompact is false, no spurious compaction) AND keeps the
  // unconditional `usage.cost.total` read in getSessionStats safe.
  private appendMarker(text: string): void {
    const sm = this.getSessionManager?.();
    if (!sm || typeof sm.appendMessage !== "function") return;
    try {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as any);
    } catch {
      // Best-effort: must never break the flow.
    }
  }

  // Opens the flush gate at flow start (file exists for the whole run).
  emitStartMarker(flowName: string): void {
    this.appendMarker(`[flow] ${flowName} started`);
  }

  // Reports completion (gate already open if start fired; harmless if not).
  emitCompletionMarker(flowName: string): void {
    this.appendMarker(`[flow] ${flowName} finished`);
  }

  // Seed the seq counter past the max seq found in a resumed session's
  // persisted records, so every record this instance writes (reconciliation
  // included) sorts AFTER the orphaned run's mid-run events. No-op if the
  // given value is below the current counter.
  seedSeq(maxSeq: number): void {
    if (Number.isFinite(maxSeq) && maxSeq + 1 > this.seq) this.seq = maxSeq + 1;
  }

  // Persist a terminal `flow_complete` record tagged with an EXPLICIT
  // flowRunId (the orphaned run's), bypassing the channel-driven flowRunId.
  // Used by resume/abort reconciliation. Best-effort; never throws.
  persistTerminal(flowRunId: string, data: unknown): void {
    const record: FlowEventRecord = {
      seq: this.seq++,
      eventType: "flow_complete",
      data,
      flowRunId,
    };
    try {
      this.pi.appendEntry<FlowEventRecord>(FLOW_EVENT_ENTRY_TYPE, record);
    } catch {
      // Best-effort: reconciliation must never break session startup.
    }
  }

  // Persist one event if its channel is a mapped flow-run event. A
  // `flow:flow-started` channel rotates a fresh flowRunId so all subsequent
  // events of the run share it.
  persist(channel: string, data: unknown): void {
    const eventType = FLOW_EVENT_NAME_MAP[channel];
    if (!eventType) return;
    if (channel === "flow:flow-started") this.flowRunId = randomUUID();
    const record: FlowEventRecord = {
      seq: this.seq++,
      eventType,
      data,
      flowRunId: this.flowRunId,
    };
    try {
      this.pi.appendEntry<FlowEventRecord>(FLOW_EVENT_ENTRY_TYPE, record);
    } catch {
      // Best-effort: persistence must never break the live flow.
    }
  }
}
