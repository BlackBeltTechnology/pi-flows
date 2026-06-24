# Dashboard Integration

pi-flows is the **engine**. pi-agent-dashboard is the **renderer**. The two repos are intentionally separate and exchange information over the pi events bus + dashboard wire protocol.

> **Note (2026-05-11):** the dashboard's plugin architecture pivoted to **server-driven intent rendering** in v0.5.3 (see `openspec/changes/archive/2026-05-11-adopt-server-driven-intent-rendering` in pi-agent-dashboard). flows-plugin now runs on the dashboard SERVER, owns canonical per-session state there, and emits JSON `IntentNode` trees broadcast to every connected client. Clients hold an `IntentStore` and resolve primitive names (e.g. `ui:action-list`, `ui:status-pill`) against a local primitive registry. **Plugins ship zero React code that runs in the browser** for migrated claims. Migration is per-claim and in progress; deferred claims still use the legacy client-side React path. None of this changes the pi-flows side — the engine continues to emit `flow:*` events and the dashboard's server-side plugin consumes them.

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

Legacy claims (`FlowDashboard`, `FlowAgentDetail`, `FlowGraph`, and any others still on the per-client React path) continue to render through the old slot-consumer mechanism in `packages/flows-plugin/src/client/` until their migration ships. The two paths coexist; the new server-driven path takes precedence for slots that have migrated.

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

A new event has to be added in **two places**, possibly three:

**1. Emit it in pi-flows.** Pick a name in the `flow:*` family. Emit at the lifecycle point where the event makes sense:

```typescript
pi.events.emit("flow:my-new-event", {
  flowName: fr.flowName,
  // ...
});
```

**2. Wire it in the dashboard.** Add an entry to `FLOW_EVENT_MAP` in `pi-agent-dashboard/packages/extension/src/flow-event-wiring.ts`:

```typescript
export const FLOW_EVENT_MAP: Record<string, string> = {
  // ...
  "flow:my-new-event": "flow_my_new_event",
};
```

**3. (If the dashboard server should react to it)** Handle the resulting protocol event in `pi-agent-dashboard/packages/flows-plugin/src/server/state-store.ts` so the canonical state-store mutates and a fresh intent tree gets broadcast. If the event only needs recording for replay (no UI change), step 2 is sufficient.

**Fast-path observability without round-tripping a dashboard PR**: emit a companion event whose name is already in `FLOW_EVENT_MAP`. This works ONLY when the companion event's reducer handler does not depend on prior state.

## Flow-run session persistence (reload survival)

Previously, flow `flow:*` events were forwarded to the dashboard **live only** and never persisted to the pi session. This meant that flow cards vanished whenever the user issued `/resume`, refreshed the browser, or the dashboard server restarted. The standard session replay via `replayEntriesAsEvents` only reconstructs `message` and `model_change` entries, not `flow:*` events.

**The solution:** pi-flows now persists flow-run lifecycle events alongside the session. The `EventEmitObserver` (in `extensions/flow-engine/flow-tui.ts`) detects each `flow:*` event and also records it to the pi session via `pi.appendEntry("flow-event", record)`. The implementation lives in `extensions/flow-engine/flow-persist.ts`:

- **`FlowEventPersister`** — manages recording logic.
- **`FLOW_EVENT_NAME_MAP`** — maps pi-flows event names (e.g. `flow:agent-started`) to the dashboard protocol names (e.g. `flow_agent_started`) so a downstream consumer can re-forward verbatim.
- **`FlowEventRecord`** (in `extensions/flow-engine/types.ts`) — the shape persisted:
  ```typescript
  { seq: number, eventType: string, data: unknown, flowRunId: string }
  ```
  where `eventType` is already the mapped dashboard protocol name (e.g. `flow_tool_call`), and `flowRunId` identifies which flow-run this event belongs to.

Persistence is **additive and best-effort**: the live event path is never blocked, and if persisting fails, the user sees no interruption. Entries are recorded with `type: "custom"` so they remain out of the LLM context and are not displayed in the terminal.

**New event: `flow:agent-error`** — pi-flows now emits a dedicated event for step-level agent failures:
```typescript
pi.events.emit("flow:agent-error", {
  agentName: string,
  stepId: string,
  text: string  // error message
});
```
This event fires from `FlowManager.onAgentComplete` (the fan-out point where all agent steps complete) when `result.success === false`. It gives the dashboard's timeline `{kind: "error"}` entry a producer. Tool errors continue to travel via `flow:subagent-tool-result` with `isError: true`.

**Reconstruction is the dashboard's responsibility.** A branch in `pi-agent-dashboard/packages/shared/src/state-replay.ts` must:
1. Extract and re-forward all `flow-event` entries (ordered by `seq`) from the session.
2. Feed them through the existing idempotent `reduceFlowEvent` to rebuild flow cards.
3. Add `FLOW_EVENT_MAP["flow:agent-error"] = "flow_agent_error"` to the wire protocol.
4. Add a `flow_agent_error` reducer case in the flows-plugin state-store.

See `openspec/changes/persist-flow-runs/DASHBOARD-DELEGATION-BRIEF.md` for the full dashboard-side specification.

**Scope note:** Architect events have been removed. Authoring now happens as ordinary main-session tool calls (`flow_agents`, `flow_write`) via the `flow_agents`/`flow_write` tools (gated by the `flows.editFlow` setting), not via `flow:architect-*` events. The **pi-agent-dashboard** companion repo must drop all `flow:architect-*` entries from its `FLOW_EVENT_MAP` in `packages/extension/src/flow-event-wiring.ts`.

**Landing:** The two repos (pi-flows and pi-agent-dashboard) land independently. Reload survival is visible to end users once **both** ship.

## TUI overlay vs server-driven renderer

Both render the same `flow:*` event stream but to different targets:

- **TUI overlay** (`extensions/flow-dashboard/`) renders in the user's terminal via pi-tui. Activated when the user issues `/flows` in the TUI. Runs in-process inside the same pi session that emits the events.
- **Server-driven renderer** (dashboard's `packages/flows-plugin/src/server/` + IntentRenderer in every connected browser) renders in the web dashboard. Server holds canonical state; clients render identically across desktop, mobile, and Capacitor APKs.

The two coexist without conflict. They share zero rendering code; they share the event stream as their source of truth.

## Why flows-plugin source stays in the dashboard repo

The recurring question: "shouldn't pi-flows own the rendering too, since it owns the engine that emits the events?"

**The answer is no.** This is a deliberate split, not an accident. Three reasons:

1. **Different dependency surfaces.** The engine has zero React, zero DOM, zero browser concerns. Forcing the dashboard's React + Vite + Vitest + jsdom + primitive-registry toolchain into pi-flows for every consumer who only wants the engine is wrong. Most pi-flows users never touch the dashboard.

2. **Different release cadence.** The engine changes when the flow YAML schema evolves (rare, breaking). The renderer changes when slot contracts, primitives, the intent protocol, or the bundled UI primitives evolve (frequent, non-breaking for engine users). Decoupling lets each move at its own pace.

3. **The server-driven intent renderer makes co-location unnecessary.** As of v0.5.3, plugins run on the dashboard server and emit JSON intent trees — they own canonical state, register handlers, and broadcast intents to every connected client. flows-plugin's server entry, state-store, and render-actions live next to the IntentStore + IntentRenderer + primitive registry they counterpart. Moving its server code to pi-flows would mean shipping the counterparty further away from the primitives it produces intent for — the wrong direction.

If you want to propose the move anyway, that's a dashboard-team architectural decision, not a pi-flows decision. Open the discussion in `pi-agent-dashboard`, not here.

## References

- Dashboard repo: <https://github.com/BlackBeltTechnology/pi-agent-dashboard>
- flows-plugin source (client + server): <https://github.com/BlackBeltTechnology/pi-agent-dashboard/tree/develop/packages/flows-plugin>
- FLOW_EVENT_MAP: <https://github.com/BlackBeltTechnology/pi-agent-dashboard/blob/develop/packages/extension/src/flow-event-wiring.ts>
- Plugin SDK + IntentRenderer + IntentStore + primitive registry: <https://github.com/BlackBeltTechnology/pi-agent-dashboard/tree/develop/packages/dashboard-plugin-runtime>
- Server-driven intent rendering (live as of v0.5.3): dashboard's `openspec/changes/archive/2026-05-11-adopt-server-driven-intent-rendering`
- `plugin-intent-protocol` capability spec: dashboard's `openspec/specs/plugin-intent-protocol/spec.md`
