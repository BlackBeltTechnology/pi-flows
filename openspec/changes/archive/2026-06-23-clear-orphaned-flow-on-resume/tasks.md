## 1. Persist read-side + reconciliation helpers (flow-persist.ts)

- [x] 1.1 Add a pure helper `findOrphanedRun(entries)` that filters `customType === "flow-event"` records, groups by `flowRunId`, picks the run with the highest max `seq`, and returns `{ flowRunId, maxSeq }` when it has no `flow_complete` record, else `null`. Read-only, never throws.
- [x] 1.2 Add `FlowEventPersister.seedSeq(maxSeq)` to set the internal `seq` counter to `maxSeq + 1` so post-resume records sort after the orphaned run's mid-run events (D3).
- [x] 1.3 Add `FlowEventPersister.persistTerminal(flowRunId, result)` that appends a `flow_complete` record tagged with the given `flowRunId` (not the channel-driven one), best-effort, monotonic `seq`.

## 2. Reconciliation routine (flow-tui.ts / EventEmitObserver)

- [x] 2.1 Add `EventEmitObserver.reconcileOrphan(reason: "session-close" | "user-abort")` that builds a terminal `FlowResult` (status `"aborted"`; summary by reason, e.g. `"Flow interrupted — parent session closed"` / `"Flow aborted (no live run)"`), emits `flow:complete` live, and calls `persister.persistTerminal(flowRunId, result)` for the detected orphan.
- [x] 2.2 Guard `reconcileOrphan` with the idempotency test from 1.1 — skip when no orphan is found (D5).

## 3. Wire into session lifecycle (index.ts)

- [x] 3.1 On `session_start`, after `sessionManager` is captured, run `findOrphanedRun(sessionManager.getEntries())`; seed the persister `seq` to `maxSeq + 1` and call `reconcileOrphan("session-close")` when an orphan is found.
- [x] 3.2 Change the `flow:abort` handler: keep `if (flowManager.isRunning) flowManager.abort();` and add an `else` branch calling `reconcileOrphan("user-abort")` (D4).

## 1b. Flush-gate marker swallow fix (flow-persist.ts)

- [x] 1b.1 In `appendMarker`, add a complete zero `usage` (`{input,output,cacheRead,cacheWrite,totalTokens,cost:{...}}` all `0`) to the appended assistant marker, so on resume `calculateContextTokens(usage)` returns `0` instead of throwing on `undefined.totalTokens` (which `emitError` swallows, dropping the next user message). Keep the non-empty text block.

## 4. Tests (__tests__/)

- [x] 4.1 `findOrphanedRun`: run without `flow_complete` → returns its `{ flowRunId, maxSeq }`; run with `flow_complete` → returns `null`; no flow-event entries → `null`; multiple runs → only the latest evaluated.
- [x] 4.2 Reconciliation emits `flow:complete` once and persists a `flow_complete` record carrying the orphaned `flowRunId`.
- [x] 4.3 Idempotency: a second scan over entries that now include the synthesized `flow_complete` returns no orphan and emits nothing.
- [x] 4.4 Seq ordering: synthesized terminal record's `seq` is strictly greater than the orphaned run's max mid-run `seq`.
- [x] 4.5 Abort handler: `isRunning=true` → `flowManager.abort()` called, no reconciliation; `isRunning=false` with an orphan → reconciliation fired.
- [x] 4.6 Marker swallow regression: start/finished markers carry the complete zero `usage`; `calculateContextTokens(marker.usage)` returns `0` and does not throw; `calculateContextTokens(undefined)` throws (documents the original bug).

## 5. Verify + document

- [x] 5.1 Run `npm run lint`, `npm run typecheck`, `npm test` — all green.
- [x] 5.2 Delegate a docs update to a subagent: note resume-time orphan reconciliation + abort-clears-stuck-card behavior in `docs/architecture.md` (and mirror to `agent-docs/architecture.md` in caveman style). Cross-repo note: no `pi-agent-dashboard` change required.
