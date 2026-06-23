## Why

Flow runs vanish on reload. pi-flows emits `flow:*` lifecycle events that the dashboard bridge forwards as **ephemeral** WebSocket messages — nothing is ever written to the pi session JSONL, and the dashboard's `replayEntriesAsEvents` only synthesizes events for `message` and `model_change` entries. So after a `/resume`, a browser refresh, or a dashboard server restart, `useSessionEvents(sessionId)` contains no `flow_*` events and the flow card disappears, even though the run happened. Subagents do not have this problem: each subagent is the `Agent` tool, so its full timeline rides home in `ToolResultMessage.details` and is replayed for free. A flow is not a tool call, so it has no such durable home — until we give it one.

## What Changes

- **pi-flows persists the `flow:*` event stream into the pi session.** On each emitted flow/architect lifecycle event, pi-flows ALSO records it as a custom session entry via `pi.appendEntry`, so the ordered stream survives process death and is available to `ctx.sessionManager.getEntries()` on reload. This is the engine-side durable home; it works whether or not the dashboard is installed.
- **The persisted entry is the event stream itself, not a derived snapshot.** Persisting the raw events (text, thinking, tool-call, tool-result — every kind) means the dashboard's existing, idempotent `reduceFlowEvent` rebuilds the identical per-agent `detailHistory` timeline on replay, with **zero new reducer cases** and automatic coverage of any future event kind. (A `FlowState` snapshot alternative is rejected in design.md — it duplicates the fold and risks silently dropping kinds.)
- **Emit a `flow:agent-error` event.** The dashboard's `FlowDetailEntry` already defines a `{ kind: "error" }` timeline entry, but **no flow event produces it** — message-level agent errors only flip `flow_agent_complete.status`, they never appear as a timeline entry. Adding the emission closes a pre-existing fidelity gap AND, because of the persistence above, errors then persist and replay for free.
- **Reconstruction is delegated to the existing dashboard reducer.** pi-flows does not rebuild flow UI state itself; the persisted events are replayed by the dashboard. (A TUI-side reconstruction is explicitly out of scope — see design.md.)
- **Dashboard-side replay is delegated, not executed here.** The dashboard must add one branch to `replayEntriesAsEvents` that re-forwards the persisted flow entries on reload. This is the dashboard team's replay/intent contract; it is specified as a hand-off in `DASHBOARD-DELEGATION-BRIEF.md` for a separate pi-agent-dashboard change.

## Capabilities

### New Capabilities

- `flow-session-persistence`: pi-flows' contract for durably recording the `flow:*` event stream into the pi session via `pi.appendEntry`, including the persisted entry shape (the cross-repo contract the dashboard replay consumes), ordering/sequence guarantees, and the scope boundary (engine persists + emits; dashboard reconstructs).

### Modified Capabilities

- `dashboard-event-emission`: add a requirement that pi-flows emits a per-agent error lifecycle event (`flow:agent-error`) so the `{ kind: "error" }` timeline entry has a producer and the dashboard can map it. This is a new mapped-event obligation under the existing emission contract.

## Impact

### Code (pi-flows)
- `extensions/flow-engine/flow-tui.ts` (or the `EventEmitObserver` / observer layer in `extensions/flow-engine/`) — wrap/duplicate `flow:*` emissions to also call `pi.appendEntry` with a sequence counter.
- `extensions/flow-engine/flow-io.ts` — add an `onError`/agent-error observer hook; emit `flow:agent-error` from the agent execution error path in `extensions/flow-engine/execution.ts` / `flow-execution.ts`.
- New persisted entry `customType` (e.g. `flow-event`) — the contract consumed by the dashboard.

### Cross-repo (delegated, NOT in this change)
- `pi-agent-dashboard/packages/shared/src/state-replay.ts` — new branch in `replayEntriesAsEvents` to re-forward persisted `flow-event` entries on reload.
- `pi-agent-dashboard/packages/extension/src/flow-event-wiring.ts` — add `flow:agent-error` → `flow_agent_error` to `FLOW_EVENT_MAP`.
- `pi-agent-dashboard/packages/flows-plugin/src/flow-reducer.ts` — add a `flow_agent_error` case appending a `{ kind: "error" }` entry to `detailHistory`.

### Dependencies
- No new runtime dependencies. Uses the existing `pi.appendEntry` extension API (`@earendil-works/pi-coding-agent`).
- No change to the live event path — persistence is additive alongside the existing ephemeral forwarding.
