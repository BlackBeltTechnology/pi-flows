## Context

A flow is an in-process artifact of the parent pi: `FlowManager._activeFlow = { promise, abortController, flowName }` (`flow-manager.ts:31,155`) driving `SessionManager.inMemory()` subagents (`execution.ts:370`). Closing the parent session destroys all of it. The only durable trace is the persisted `flow-event` stream written by `FlowEventPersister` (`flow-persist.ts`), recording one entry per mapped lifecycle event as `{ seq, eventType, data, flowRunId }`. The terminal `flow_complete` record is written only from `EventEmitObserver.onFlowComplete` (`flow-tui.ts:675`), which is only reached when the in-process promise settles (`flow-manager.ts:162/189`). A hard kill never reaches it, so the persisted stream ends mid-run with no terminal record.

On resume the dashboard replays the persisted records (ordered by `seq`) into its idempotent reducer, rebuilding the card to its last (non-terminal) state. Two engine-side facts then strand it:
1. No terminal `flow_complete` exists, so the reducer keeps the card "running".
2. `flow:abort` is gated by `if (flowManager.isRunning)` (`index.ts:453`); on a resumed session `_activeFlow === null` so the handler is a no-op — the only clear path is dead.

The `FlowEventRecord.flowRunId` field already documents itself as "the supersede key for any future terminal-collapse entry" (`types.ts`), so the data contract for reconciliation is pre-baked.

## Goals / Non-Goals

**Goals:**
- A flow run interrupted by parent-session close reaches a terminal, clearable state on the next resume — without cooperation from the dead process.
- An Abort received on a resumed session with no live flow clears the stuck card instead of being a silent no-op.
- Reconciliation is idempotent: a run already carrying a terminal `flow_complete` is never re-terminated.
- Synthesized terminal records replay in the correct position so the dashboard reducer applies them after the run's mid-run events.

**Non-Goals:**
- Resumable flows (checkpoint + re-drive of executable state). Out of scope.
- A `SIGTERM` graceful-flush handler — the resume-time scan covers hard kills too, making it redundant.
- Dashboard-side changes — the synthesized `flow_complete` rides the existing replay/reducer path unchanged.
- Reconstructing flow UI state in pi-flows (forbidden by `flow-session-persistence`'s reconstruction-ownership boundary). We emit one terminal event; the consumer still reduces.

## Decisions

### D1: Detect orphans by scanning persisted `flow-event` entries on `session_start`

On `session_start`, read `sessionManager.getEntries()` (already exposed via `flow:get-session-entries`, `index.ts:422`), filter to `customType === "flow-event"`, group records by `flowRunId`, and take the most recent run (highest max `seq`). If that run has no record with `eventType === "flow_complete"`, it is orphaned.

- **Why scan, not a flag:** a hard kill leaves no opportunity to set a "was running" flag. The persisted stream is the only durable signal and it is already there.
- **Alternative considered — dashboard-side synthesis on session-end:** rejected for this change because pi-flows owns the `flow:complete`/`FlowResult` shape; emitting from the engine keeps the contract single-sourced. (Still viable as a defense-in-depth follow-up in the dashboard.)

### D2: Emit a synthesized terminal `flow:complete` tagged with the orphan's `flowRunId`

Reconciliation emits the `flow:complete` channel live (for connected dashboards) AND persists a `flow_complete` record carrying the **orphaned run's** `flowRunId` (the supersede key), with a `FlowResult` of `status: "interrupted"` and a summary such as `"Flow interrupted — parent session closed"`.

- The live emit clears any connected client immediately; the persisted record makes the next cold resume idempotent (the run now has a terminal record).
- The resumed `FlowEventPersister` instance has `flowRunId === ""` and would otherwise tag the record with the wrong run. Reconciliation therefore needs a dedicated persist path that accepts an explicit `flowRunId` rather than reusing the channel-driven `persist()`.

### D3: Seed the resumed persister's `seq` past the max persisted `seq`

`FlowEventPersister.seq` restarts at `0` on each new instance. A synthesized terminal written at `seq=0` would sort BEFORE the orphan run's mid-run events (`seq=5,6,7…`), causing the reducer to terminate the card before replaying its timeline. During the resume scan we already compute the max `seq` across persisted records; seed the new persister's counter to `maxSeq + 1` so every subsequent record — reconciliation included — sorts last.

- **Alternative — timestamp ordering:** rejected; the contract orders by `seq` and the reducer is built around it. Seeding `seq` keeps one ordering authority.

### D4: Wire `flow:abort` to reconcile when no flow is live

Change the handler so that when `flowManager.isRunning` is false it triggers the same reconciliation (terminate the latest non-terminal run) instead of returning silently:

```
pi.events.on("flow:abort", () => {
  if (flowManager.isRunning) flowManager.abort();
  else reconcileOrphanedFlow("user-abort");
});
```

- `reconcileOrphanedFlow` is the shared routine from D1–D3; the abort path passes a reason so the synthesized summary reads `"Flow aborted (no live run)"` vs `"Flow interrupted — parent session closed"` for the resume path.

### D5: Idempotency via the `flow_complete` presence test

The orphan test (D1) is the idempotency guard: once a run has any `flow_complete` record — from a clean completion, a previous resume's reconciliation, or an abort reconciliation — it is no longer orphaned and reconciliation is skipped. No separate dedupe state is needed.

## Risks / Trade-offs

- **Seq mis-ordering terminates the card early** → seed `seq` past max persisted (D3); covered by a replay-ordering test.
- **Multiple flow runs in one session, only the last interrupted** → group by `flowRunId` and reconcile only runs lacking a terminal record; earlier clean runs are untouched.
- **Reconciliation fires while a flow is genuinely still running** (e.g. a spurious resume scan racing a live start) → scan runs at `session_start` before any flow can be re-launched, and the abort path is explicitly gated on `!isRunning`. Reconciliation only ever targets runs with no live `_activeFlow`.
- **A run that crashed mid-write leaves a torn last record** → JSONL append is line-atomic per entry; a torn trailing line is ignored by the entry loader, so the worst case is the scan missing the last event, not a malformed terminal.
- **Best-effort persistence may swallow the reconciliation write** → consistent with existing `FlowEventPersister` semantics (never throw into the live path); the live emit still clears connected clients even if the persist write is dropped.

## Migration Plan

Additive. No persisted-record shape change (`flowRunId` already present). No dashboard change required. Rollback is removing the `session_start` scan and reverting the `flow:abort` handler to its `isRunning`-only form; existing sessions are unaffected because reconciliation only adds terminal records that the reducer already understands.

## Open Questions

- ~~Should the synthesized terminal `FlowResult.status` be a new value (`"interrupted"`) or reuse `"aborted"`?~~ **Resolved: reuse `"aborted"`.** `FlowResult.status` is typed `"success" | "error" | "aborted"` (`types.ts:186`) and the existing user-abort path already emits `"aborted"` (`flow-manager.ts:189`). Introducing `"interrupted"` would break the type and the dashboard reducer's status enum. Cause is distinguished via the `summary` text (`"Flow interrupted — parent session closed"` vs `"Flow aborted (no live run)"`), not the status field.
