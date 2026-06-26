# Dashboard Integration

pi-flows: **engine**. pi-agent-dashboard: **renderer**. Repos intentionally separate. Exchange info over pi events bus + dashboard wire protocol.

> **Note (2026-05-11):** dashboard plugin architecture pivoted to **server-driven intent rendering** in v0.5.3 (see `openspec/changes/archive/2026-05-11-adopt-server-driven-intent-rendering` in pi-agent-dashboard). flows-plugin runs on dashboard SERVER, owns canonical per-session state there, emits JSON `IntentNode` trees broadcast to every connected client. Clients hold `IntentStore`, resolve primitive names (e.g. `ui:action-list`, `ui:status-pill`) against local primitive registry. **Plugins ship zero React code running in browser** for migrated claims. Migration per-claim, in progress. Deferred claims still use legacy client-side React path. Does not change pi-flows side — engine continues emitting `flow:*` events; dashboard server-side plugin consumes them.

## Architecture

```
┌────────────────── USER'S TERMINAL ──────────────────┐
│                                                      │
│   pi-flows engine (THIS repo)                        │
│   extensions/flow-engine/                            │
│     │                                                │
│     │  pi.events.emit("flow:flow-started", {...})    │
│     │  pi.events.emit("flow:agent-started", {...})   │
│     │  pi.events.emit("flow:agent-complete", {...})  │
│     │  ... 27 other flow:* events                    │
│     ▼                                                │
│   pi events bus                                      │
│     │                                                │
│     │  pi-agent-dashboard's bridge extension         │
│     │  (loaded as a pi extension inside this same    │
│     │   pi session) catches every flow:* event       │
│     │  via packages/extension/src/flow-event-        │
│     │  wiring.ts and translates it to a dashboard    │
│     │  protocol message via FLOW_EVENT_MAP.          │
│     ▼                                                │
│   WebSocket → dashboard server                       │
└──────────────────────────┼───────────────────────────┘
                           │
                           ▼
┌────── DASHBOARD SERVER (NEW: plugin runs here) ──────┐
│                                                      │
│   packages/flows-plugin/src/server/                  │
│     index.ts          (registerPlugin, handlers)     │
│     state-store.ts    (per-session canonical state)  │
│     render-actions.ts (state → IntentNode tree)      │
│     │                                                │
│     │  state-store runs the existing flow-reducer    │
│     │  on incoming protocol events, then renders     │
│     │  a fresh intent tree:                           │
│     │     { primitive: "ui:action-list",             │
│     │       props: { actions: [...] } }              │
│     ▼                                                │
│   ctx.broadcastToSubscribers({                       │
│     type: "plugin_intents",                          │
│     pluginId, sessionId, slot, intent })             │
│     │                                                │
│     ▼                                                │
│   WebSocket fan-out → every connected client         │
└──────────────────────────┼───────────────────────────┘
                           │
                           ▼
┌──────────── BROWSER (one of N clients) ──────────────┐
│                                                      │
│   useMessageHandler dispatches on "plugin_intents"   │
│     │                                                │
│     ▼                                                │
│   IntentStore: Map<(pluginId, sessionId, slot),      │
│                    IntentNode>                       │
│     │                                                │
│     ▼                                                │
│   Slot consumer (e.g. SessionCardActionBarSlot)      │
│     → IntentRenderer walks the JSON tree             │
│     → Resolves each "ui:*" primitive via             │
│        the local UI primitive registry               │
│     → Renders the React component tree               │
│     → ActionDescriptor onClick handlers send         │
│        "plugin_action" messages back to server       │
│                                                      │
│   Every connected client renders identically.        │
└──────────────────────────────────────────────────────┘
```

Legacy claims (`FlowDashboard`, `FlowAgentDetail`, `FlowGraph`, others still on per-client React path) continue rendering through old slot-consumer mechanism in `packages/flows-plugin/src/client/` until migration ships. Two paths coexist; new server-driven path takes precedence for migrated slots.

## Where things live

| Concern | Repo | Path |
|---|---|---|
| Flow execution engine | pi-flows (this repo) | `extensions/flow-engine/` |
| TUI overlay (terminal rendering) | pi-flows (this repo) | `extensions/flow-dashboard/`, `extensions/flow-summary/` |
| Flow event emission | pi-flows (this repo) | `extensions/flow-engine/flow-tui.ts` (EventEmitObserver) |
| Role manager | pi-flows (this repo) | `extensions/role-manager.ts` |
| Bridge: pi events → dashboard wire protocol | pi-agent-dashboard | `packages/extension/src/flow-event-wiring.ts` |
| Dashboard wire-protocol types | pi-agent-dashboard | `packages/shared/src/types.ts` |
| Plugin server state + intent rendering | pi-agent-dashboard | `packages/flows-plugin/src/server/` |
| Plugin client (legacy claims pending migration) | pi-agent-dashboard | `packages/flows-plugin/src/client/` |
| IntentStore + IntentRenderer + primitive registry | pi-agent-dashboard | `packages/dashboard-plugin-runtime/` |
| Slot taxonomy | pi-agent-dashboard | `packages/dashboard-plugin-runtime/` (`@blackbelt-technology/dashboard-plugin-runtime`) |

## How to add a new flow event

New event added in **two places**, possibly three:

**1. Emit in pi-flows.** Pick name in `flow:*` family. Emit at lifecycle point where event makes sense:

```typescript
pi.events.emit("flow:my-new-event", {
  flowName: fr.flowName,
  // ...
});
```

**2. Wire in dashboard.** Add entry to `FLOW_EVENT_MAP` in `pi-agent-dashboard/packages/extension/src/flow-event-wiring.ts`:

```typescript
export const FLOW_EVENT_MAP: Record<string, string> = {
  // ...
  "flow:my-new-event": "flow_my_new_event",
};
```

**3. (If dashboard server should react)** Handle resulting protocol event in `pi-agent-dashboard/packages/flows-plugin/src/server/state-store.ts` so canonical state-store mutates and fresh intent tree broadcasts. If event only needs recording for replay (no UI change), step 2 suffices.

**Fast-path observability without round-tripping dashboard PR**: emit companion event whose name already in `FLOW_EVENT_MAP`. Works ONLY when companion event's reducer handler does not depend on prior state.

## Flow-run session persistence (reload survival)

**Problem:** flow `flow:*` events forwarded live-only (ephemeral). Never persisted. Cards vanish on `/resume`, browser refresh, dashboard server restart. `replayEntriesAsEvents` replays only `message` + `model_change` entries, not `flow:*` events.

**Solution in pi-flows:** `EventEmitObserver` (extensions/flow-engine/flow-tui.ts) records each flow-run lifecycle event to pi session via `pi.appendEntry("flow-event", record)`. Implemented in extensions/flow-engine/flow-persist.ts.

- **`FlowEventPersister`** manages recording.
- **`FLOW_EVENT_NAME_MAP`** maps pi-flows event names → dashboard protocol names (e.g. `flow:agent-started` → `flow_agent_started`). Consumer re-forwards verbatim.
- **`FlowEventRecord`** shape (extensions/flow-engine/types.ts): `{ seq, eventType, data, flowRunId }` where `eventType` is already the mapped dashboard protocol name (e.g. `flow_tool_call`). `flowRunId` identifies which flow-run owns the event.

Persistence additive, best-effort. Live path never blocked. Entries recorded as `type: "custom"` (out of LLM context, not displayed).

**New event: `flow:agent-error { agentName, stepId, text }`** 
- Fires from `FlowManager.onAgentComplete` fan-out when `result.success === false`.
- Step-level agent failure event. Gives dashboard `{kind: "error"}` timeline entry a producer.
- Tool errors still travel via `flow:subagent-tool-result` (`isError`).

**Reconstruction: dashboard's job.** Branch in `pi-agent-dashboard/packages/shared/src/state-replay.ts` must:
- Extract re-forward `flow-event` entries (ordered by `seq`).
- Feed through `reduceFlowEvent` to rebuild cards (idempotent).
- Add `FLOW_EVENT_MAP["flow:agent-error"] = "flow_agent_error"` to wire protocol.
- Add `flow_agent_error` reducer case in flows-plugin state-store.

See `openspec/changes/persist-flow-runs/DASHBOARD-DELEGATION-BRIEF.md`.

**Scope:** Architect events removed. Authoring now ordinary main-session tool calls (`flow_agents`, `flow_write`) via the `flow_agents`/`flow_write` tools (gated by the `flows.editFlow` setting), not `flow:architect-*` events. **pi-agent-dashboard** must drop all `flow:architect-*` entries from `FLOW_EVENT_MAP` in `packages/extension/src/flow-event-wiring.ts`.

**Landing:** Two repos land independently. Reload survival visible once both ship.

## Node kind on agent lifecycle events

`NodeKind` first-class discriminator. Carried end-to-end on flow node lifecycle events.
`NodeKind` = `"agent" | "fork" | "agent-decision" | "code" | "code-decision" | "flow-ref"`. Defined extensions/flow-engine/types.ts.
`NodeKind` is node TYPE. Distinct from dashboard timeline-entry `kind` (`text | thinking | tool | error`). Timeline-entry `kind` describes entries inside card.

`EventEmitObserver` puts `nodeKind` on `flow:agent-started` + `flow:agent-complete` payloads for ALL node types.
Before: only `code`/`code-decision` carried tag. Dropped at FlowManager fan-out.
`code`/`code-decision` started events also carry resolved handler `target` path.

`FlowEventRecord.data` = exact emitted payload. `nodeKind` lands in persisted records automatically. NO `FlowEventRecord` interface change.
Replay: dashboard `reduceFlowEvent` reconstructs card TYPE (not just timeline). Reads `nodeKind` off recorded `flow_agent_started`.

`code`/`code-decision` card `assistant-text` entries = program logs by card `nodeKind`. No new event type. No per-line marker. Dashboard infers logs from card kind.

**Cross-repo follow-up:** NO new `FLOW_EVENT_MAP` entry.
pi-agent-dashboard change reducer-side only. Read `nodeKind` off `flow_agent_started` to select card renderer. Live AND replayed runs.
Two repos land independently. Unknown/absent `nodeKind` degrades gracefully to generic node card.

## Inbound event: `flow:set-edit-mode`

Most `flow:*` events go pi-flows -> dashboard. `flow:set-edit-mode { enabled: boolean }` goes dashboard -> pi-flows.
Dashboard emits it to toggle authoring edit-mode live. Mirrors `/flows:edit-mode <on|off>` command.

```typescript
pi.events.emit("flow:set-edit-mode", { enabled: true });
```

Handler writes `flows.editFlow` to project `.pi/settings.json`. Syncs project-local `manage-flows` skill `.pi/skills/manage-flows/SKILL.md` (frontmatter `disable-model-invocation` = `!enabled`). Reconciles `flow_agents`/`flow_write` tools.
Event path: tools update immediately. Skill visibility next session start. Event runs base `ExtensionContext`, cannot reload (only command path calls `ctx.reload()`). See events-api.md.

## TUI overlay vs server-driven renderer

Both render same `flow:*` event stream to different targets:

- **TUI overlay** (`extensions/flow-dashboard/`) renders in user's terminal via pi-tui. Activates on `/flows` in TUI. Runs in-process inside same pi session emitting events.
- **Server-driven renderer** (dashboard's `packages/flows-plugin/src/server/` + IntentRenderer in every connected browser) renders in web dashboard. Server holds canonical state; clients render identically across desktop, mobile, Capacitor APKs.

Two coexist without conflict. Share zero rendering code; share event stream as source of truth.

## Why flows-plugin source stays in dashboard repo

Recurring question: "shouldn't pi-flows own the rendering too, since it owns the engine emitting the events?"

**Answer: no.** Deliberate split, not accident. Three reasons:

1. **Different dependency surfaces.** Engine has zero React, zero DOM, zero browser concerns. Forcing dashboard's React + Vite + Vitest + jsdom + primitive-registry toolchain into pi-flows for every consumer who only wants engine is wrong. Most pi-flows users never touch dashboard.

2. **Different release cadence.** Engine changes when flow YAML schema evolves (rare, breaking). Renderer changes when slot contracts, primitives, intent protocol, or bundled UI primitives evolve (frequent, non-breaking for engine users). Decoupling lets each move at own pace.

3. **Server-driven intent renderer makes co-location unnecessary.** As of v0.5.3, plugins run on dashboard server, emit JSON intent trees — own canonical state, register handlers, broadcast intents to every connected client. flows-plugin's server entry, state-store, render-actions live next to IntentStore + IntentRenderer + primitive registry they counterpart. Moving server code to pi-flows means shipping counterparty further from primitives it produces intent for — wrong direction.

To propose move anyway: dashboard-team architectural decision, not pi-flows decision. Open discussion in `pi-agent-dashboard`, not here.

## References

- Dashboard repo: <https://github.com/BlackBeltTechnology/pi-agent-dashboard>
- flows-plugin source (client + server): <https://github.com/BlackBeltTechnology/pi-agent-dashboard/tree/develop/packages/flows-plugin>
- FLOW_EVENT_MAP: <https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/develop/packages/extension/src/flow-event-wiring.ts>
- Plugin SDK + IntentRenderer + IntentStore + primitive registry: <https://github.com/BlackBeltTechnology/pi-agent-dashboard/tree/develop/packages/dashboard-plugin-runtime>
- Server-driven intent rendering (live as of v0.5.3): dashboard's `openspec/changes/archive/2026-05-11-adopt-server-driven-intent-rendering`
- `plugin-intent-protocol` capability spec: dashboard's `openspec/specs/plugin-intent-protocol/spec.md`
