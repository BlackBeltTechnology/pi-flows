## Why

A flow runs entirely in-process in the parent pi: `FlowManager` tracks it as an in-memory `_activeFlow = { promise, abortController, flowName }` (`flow-manager.ts:31,155`) whose subagents are `SessionManager.inMemory()` sessions (`execution.ts:370`). When the parent session is closed mid-run, the promise, the `AbortController`, and every subagent are destroyed at once — there is no checkpoint and no graceful-shutdown hook (no `SIGTERM`/`process.on` exists in `flow-engine/`). The terminal `flow:complete` event and completion marker fire ONLY from the promise's `.then`/`.catch` (`flow-manager.ts:162,189` → `flow-tui.ts:680`), so a hard kill persists a stream that ends mid-run with no terminal record.

On `pi --continue`, `FlowManager` is re-instantiated with `_activeFlow = null`; the persisted `flow-event` stream is replayed as display data only. The dashboard rebuilds the flow card to its last persisted (non-terminal) state and it stays "running" forever. The Abort button is a no-op: `flow:abort` is gated by `if (flowManager.isRunning) flowManager.abort()` (`index.ts:453-454`), and `isRunning` is `false` on a resumed session, so the handler short-circuits before doing anything. The card can never reach a terminal, clearable state.

## What Changes

- On session start/resume, pi-flows SHALL scan persisted `flow-event` entries for the most recent flow run and, if it has no terminal `flow_complete` record, emit a single synthesized terminal event (`flow:complete` with `status: "interrupted"`) so the consumer's existing reducer transitions the stuck card to a terminal state. This survives a hard kill because it requires no cooperation from the dead process — only the persisted stream.
- The `flow:abort` handler SHALL no longer silently short-circuit when there is no live `_activeFlow`. When abort is received and no flow is running (the resumed-session case), pi-flows SHALL emit the same synthesized terminal event so the dashboard clears the card.
- Reconciliation SHALL be idempotent: a flow run that already carries a terminal `flow_complete` (clean completion, or already reconciled) SHALL NOT receive a second terminal event.
- The assistant flush-gate markers (`flow-persist.ts` `appendMarker`) SHALL carry a complete zero `usage` object. Without it, on resume pi's `_findLastAssistantMessage()` returns the marker and the next user send throws in `calculateContextTokens(usage.totalTokens)` (`compaction.js:79`); the throw is swallowed by `emitError({event:"send_user_message"})`, silently dropping the user's message. Triple-confirmed via captured pi stderr (`Cannot read properties of undefined (reading 'totalTokens')`).

Non-goals (explicitly out of scope):
- **Resumable flows.** Checkpointing executable orchestration state (steps done/pending, subagent sessions) and re-driving a flow on resume is a separate, large feature. This change only drives a dead flow to a terminal state.
- **Dashboard-side terminal synthesis.** The companion `pi-agent-dashboard` could synthesize a terminal event when a session ends; this proposal places the fix in pi-flows because pi-flows owns the flow lifecycle semantics and the `flow:complete` event shape.
- **A `SIGTERM` graceful-flush handler.** It only helps a graceful close; the resume-time scan also covers hard kills, so the handler is not required.

## Capabilities

### New Capabilities
- `flow-orphan-reconciliation`: Detecting a flow run that was interrupted by parent-session close (no terminal record in the persisted stream) and driving it to a terminal, clearable state — both at resume time (scan + synthesize) and on an abort received with no live flow.

### Modified Capabilities
- `flow-session-persistence`: ADDED requirement — flush-gate markers carry a resume-safe zero `usage` so the next user send after resume cannot throw in pi's compaction/stats token math.

<!-- The synthesized terminal event rides the existing mapped-event contract
     in `dashboard-event-emission`; no existing requirement there is changing. -->

## Impact

- `extensions/flow-engine/index.ts` — `flow:abort` handler (`:453`); new resume-time scan on `session_start`.
- `extensions/flow-engine/flow-manager.ts` — surface for emitting a synthesized terminal `flow:complete`/reconciliation when no live `_activeFlow` exists.
- `extensions/flow-engine/flow-persist.ts` — read-side helper to locate the latest flow run and test for a terminal `flow_complete` among persisted `flow-event` entries (`FLOW_EVENT_NAME_MAP`); and the `appendMarker` zero-`usage` fix (swallow regression).
- Consumer (`pi-agent-dashboard`): no code change required — the synthesized `flow_complete` rides the existing replay/reducer path. Cross-repo note only.
- No new dependencies. No breaking changes to persisted record shape.
