# Dashboard-side delegation brief — persist-flow-runs

This change in `pi-flows` makes flow runs **durable**: every flow-run lifecycle
event is now recorded into the pi session via `pi.appendEntry("flow-event", …)`
(see `extensions/flow-engine/flow-persist.ts`). But persistence alone is
**inert** — flow cards still vanish on reload — until `pi-agent-dashboard`
learns to replay these entries. This brief specifies the dashboard-side work as
a **separate pi-agent-dashboard change**.

Per the repo's architecture (`agent-docs/dashboard-integration.md`): pi-flows
owns the engine + events + their durability; the dashboard owns the React
reaction and the **replay/intent contract**. The replay branch and reducer case
below are the **dashboard team's architectural decision** and must be
implemented in their repo, not here.

## Background: why nothing survives reload today

- Flow events are forwarded **live-only** via the bridge's `pi.events.emit`
  monkey-patch (`packages/extension/src/bridge.ts:~697`) as ephemeral
  `event_forward` messages. They were never persisted.
- `replayEntriesAsEvents` (`packages/shared/src/state-replay.ts`) only
  synthesizes events for `entry.type === "message"` and `"model_change"`.
  `type:"custom"` entries are silently skipped.
- So after `/resume`, browser refresh, or dashboard server restart,
  `useSessionEvents(sessionId)` has no `flow_*` events → the flows-plugin
  client reducer rebuilds nothing → card gone.

pi-flows now persists the events; the dashboard must re-forward them on replay.

## The persisted entry contract (produced by pi-flows — do not change shape here)

`pi.appendEntry` writes a `type:"custom"` session entry with
`customType: "flow-event"` and this `data` shape (`FlowEventRecord` in
`pi-flows/extensions/flow-engine/types.ts`):

```jsonc
{
  "seq": 12,                      // monotonic per session; ORDER replay by this
  "eventType": "flow_tool_call",  // ALREADY the dashboard protocol name
  "data": { /* exact payload the bridge would have forwarded */ },
  "flowRunId": "uuid"             // disambiguates multiple runs in one session
}
```

`eventType` is the **already-mapped** protocol name (`flow_started`,
`flow_agent_started`, `flow_agent_complete`, `flow_assistant_text`,
`flow_thinking_text`, `flow_tool_call`, `flow_tool_result`, `flow_auto_decision`,
`flow_loop_iteration`, `flow_agent_error`, `flow_complete`). The replay branch
therefore re-forwards `{ eventType, data }` **verbatim** — no second mapping
table needed.

## Required change 1 — replay branch (the load-bearing edit)

**File:** `packages/shared/src/state-replay.ts`, inside `replayEntriesAsEvents`'s
entry loop.

Add a branch that re-forwards persisted flow events. Collect `flow-event`
entries, order by `seq`, and emit one `event_forward` each:

```typescript
// alongside the existing "message" / "model_change" branches:
if (entry.type === "custom" && entry.customType === "flow-event") {
  const rec = entry.data as { seq: number; eventType: string; data: unknown };
  // push as a normal forwarded event; existing reducer consumes it
  messages.push(makeEvent(sessionId, rec.eventType, ts, rec.data as Record<string, unknown>));
}
```

If entries can arrive out of order relative to `seq`, sort the collected
`flow-event` records by `seq` before pushing. (They are appended in `seq`
order, so file order already matches `seq` in practice; sort defensively.)

**No client component or reducer change is needed for the existing timeline
kinds** — `useSessionEvents(sessionId)` will now contain the `flow_*` events and
the existing idempotent `reduceFlowEvent` rebuilds the identical per-agent
`detailHistory`. Verified: the timeline renderer already handles every
`FlowDetailEntry` kind including `error` (`FlowArchitect.tsx`,
`FlowAgentDetail.tsx`).

## Required change 2 — map the new error event

**File:** `packages/extension/src/flow-event-wiring.ts` — add to `FLOW_EVENT_MAP`:

```typescript
"flow:agent-error": "flow_agent_error",
```

(pi-flows now emits `flow:agent-error { agentName, stepId, text }` for
step-level agent failures. This makes the live path forward it too, not only
the replay path.)

## Required change 3 — reducer case for the error timeline entry

**File:** `packages/flows-plugin/src/flow-reducer.ts` — add a case appending an
error entry to the agent's `detailHistory` (the `{ kind: "error" }` variant of
`FlowDetailEntry` already exists; only the producer case is missing):

```typescript
case "flow_agent_error": {
  // find the agent by stepId/agentName, append { kind: "error", text } to detailHistory
}
```

## Verification (after the dashboard change lands)

1. Run a flow in a session with the dashboard attached.
2. Refresh the browser / restart the dashboard server / `/resume` the pi session.
3. The flow card SHALL reappear with the full per-agent timeline (assistant
   text, thinking, tool calls + results, and any errors), rebuilt from the
   replayed `flow-event` entries.
4. A step-level agent failure SHALL show a `{ kind: "error" }` entry in the
   agent's timeline (not only a red status).

## Independence / ordering

The two repos land **independently, any order**:

- pi-flows persistence is harmless without the dashboard branch (inert custom
  entries; session resume unaffected).
- the dashboard branch is harmless without persisted entries (nothing to
  replay).

Reload survival becomes user-visible only once **both** are deployed.

## Note: the server `onEvent`/`stateStore` path is NOT a substitute

`ServerPluginContext` exposes `onEvent(sessionId, event)` and the flows-plugin
has a `stateStore.applyEvent` (currently unwired). Wiring that would give
*live-reconnect* rebroadcast, but it is RAM-only — lost on server restart and
absent on a fresh pi `/resume`. Durable reload REQUIRES the session-persistence
+ replay path above. Treat the server path as a separate, optional enhancement.
