## 1. Persisted event contract (pi-flows)

- [x] 1.1 Define the `flow-event` record type in `extensions/flow-engine/types.ts`: `{ seq: number; eventType: string; data: unknown; flowRunId: string }` (eventType = dashboard protocol name).
- [x] 1.2 Add a per-session monotonic `seq` counter and a `flowRunId` source on the observer/emit layer (reset/assigned at flow start). — `FlowEventPersister` in `flow-persist.ts`; `flowRunId` rotates on `flow:flow-started`.
- [x] 1.3 Locate the single emit site that forwards `flow:*` events (the `EventEmitObserver` / observer layer in `extensions/flow-engine/`) so persistence derives from the same payload object as the live emit.

## 2. Durable recording via appendEntry (pi-flows)

- [x] 2.1 At the shared emit site (`EventEmitObserver.emit`), after `pi.events.emit`, also call `pi.appendEntry("flow-event", record)` via `FlowEventPersister.persist`.
- [x] 2.2 Map raw `flow:*` channel names to dashboard protocol names at the persist site — `FLOW_EVENT_NAME_MAP` in `flow-persist.ts`, mirroring the flow-run subset of the dashboard `FLOW_EVENT_MAP`.
- [x] 2.3 Confirm persistence covers every flow-run timeline kind emitted by `EventEmitObserver`. (Architect events scoped out — helper reusable.)
- [x] 2.4 Verify `pi.appendEntry` is available on the extension API and that entries are `type:"custom"` — confirmed `appendEntry<T>(customType, data?)` at `pi-coding-agent` types.d.ts:845.

## 3. Close the error-timeline fidelity gap (pi-flows)

- [x] 3.1 Add an error hook (`onError`) to the `FlowObserver` interface in `extensions/flow-engine/flow-io.ts`.
- [x] 3.2 Surface step-level agent failure as `flow:agent-error { agentName, stepId, text }`. Implemented at the single `FlowManager.onAgentComplete` fan-out chokepoint (derives from `result.success === false`, fires `onError` before the status flip), rather than scattering emits across `flow-execution.ts`. Retains the existing `flow:agent-complete` `status:"error"`.
- [x] 3.3 `EventEmitObserver.onError` routes through the shared `emit` → persisted as `eventType:"flow_agent_error"`.

## 3b. Flush-gate marker (pi-flows)

- [x] 3b.1 Add `emitCompletionMarker(flowName)` to `FlowEventPersister`: append a NON-EMPTY assistant text block (`[flow] <name> finished`) via the captured `ctx.sessionManager.appendMessage` to open pi's sticky `hasAssistant` flush gate. Best-effort; never throws.
- [x] 3b.2 Wire `() => sessionManager` into `EventEmitObserver` (move `sessionManager` decl above its construction in `index.ts`); call `emitCompletionMarker` from `onFlowComplete` after emitting `flow:complete`.
- [x] 3b.3 No guards: emit per flow completion (leading + consecutive assistant markers verified accepted by claude-haiku-4-5; empty text block forbidden — 400 on resume).

## 4. Tests (pi-flows)

- [x] 4.1 Unit test: sequence of events appends matching `flow-event` entries (seq order, mapped `eventType`, payload equality) — `__tests__/flow-persist.test.ts`.
- [x] 4.2 Unit test: strictly increasing `seq` across many events; `flowRunId` shared per run and rotates per run.
- [x] 4.3 Unit test: assistant-text + thinking + tool-call + tool-result + agent-error all persist (full fidelity), not just tool calls.
- [x] 4.4 Unit test: `flow:agent-error` maps to `flow_agent_error`; unmapped/architect channels skipped; best-effort (appendEntry throw does not propagate).
- [x] 4.5 Run `npm run lint` (0 errors), `npm run typecheck` (clean), `npm test`.
- [x] 4.7 Marker tests: `emitCompletionMarker` appends a non-empty assistant text block; no-op without sessionManager; never throws; and an integration test (persister + real `SessionManager`) proving a flow-first run reaches disk only after the marker and survives cold reload.
- [x] 4.6 Regression test against the REAL `SessionManager` + `buildSessionContext` (`__tests__/flow-persist-sessionmanager.test.ts`): sticky deferred-flush gate, cold-reload recovery, JSONL integrity, and `custom` flow-events excluded from built LLM context while empty messages emit verbatim (proves the no-injection rule).

## 5. Cross-repo hand-off (delegated to pi-agent-dashboard)

- [x] 5.1 Author `DASHBOARD-DELEGATION-BRIEF.md` in this change directory specifying: the `flow-event` entry contract, the `replayEntriesAsEvents` re-forward branch (sort by `seq`, emit `event_forward{eventType,data}`), the `FLOW_EVENT_MAP["flow:agent-error"]="flow_agent_error"` addition, and the `flow_agent_error` reducer case appending `{kind:"error",text}` to `detailHistory`.
- [x] 5.2 State explicitly in the brief that the dashboard replay/reducer is the dashboard team's architectural decision and is implemented in a separate pi-agent-dashboard change.

## 6. Documentation

- [x] 6.1 Delegate to a subagent: update `docs/dashboard-integration.md` (and mirror into `agent-docs/dashboard-integration.md`, caveman style) describing the durable-recording path. — New "Flow-run session persistence" section added to both trees (line 119).
- [x] 6.2 Add a one-line pointer for the new `flow-session-persistence` capability where appropriate. — Covered by the new dashboard-integration section + CHANGELOG.
- [x] 6.3 Add a CHANGELOG.md entry under the unreleased section.

## 7. Validation

- [x] 7.1 Run `openspec validate persist-flow-runs --strict` and resolve any issues.
