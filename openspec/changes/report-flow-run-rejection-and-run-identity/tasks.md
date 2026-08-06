## 1. Tests (TDD)

- [x] 1.1 Test: `buildDispatchRejection` payload carries `status:"rejected"`, top-level `reason`, `flowName`, and mirrors `reason` into `lastResult.result.summary`; omits `results`; carries no `runId`.
- [x] 1.2 Test: the shared reason builders are byte-identical to the slash-command strings (`flowNotFoundMessage`, `flowAlreadyRunningMessage`).
- [x] 1.3 Test (identity): `FlowManager.start()` mints a runId, delivers it to `onFlowStarted`, and stamps `FlowResult.runId`; two sequential runs get different ids.
- [x] 1.4 Test (atomicity): a second dispatch before the first `start()` resolves is declined (throws "already running"); `runFlow` called exactly once.
- [x] 1.5 Test (identity, headless): `EventEmitObserver` stamps the `onFlowStarted` runId on `flow:flow-started` and every subsequent payload.
- [x] 1.6 Run the new tests; confirm red, then green after implementation.

## 2. Dispatch: terminal rejection + atomic guard (flow-run-dispatch)

- [x] 2.1 Extract shared reason builders (`flowNotFoundMessage`, `flowAlreadyRunningMessage`) + `buildDispatchRejection` at module scope; use the builders on BOTH the command path (`flow:notify`) and the dispatch path so parity holds by construction.
- [x] 2.2 `runFlowByName` emits the terminal `flow:complete` rejection (`status:"rejected"` + `reason`) for unknown-flow / already-running / gate-blocked instead of returning silently.
- [x] 2.3 Delete the duplicate `isRunning` guard ① in the `flow:run` handler (single choke point).
- [x] 2.4 Make `FlowManager.start()` check-to-assign atomic via a synchronous-prologue IIFE (mark `_activeFlow` before the first `await`).
- [x] 2.5 Wrap the handler's `start()` call so the now-reachable "already running" throw becomes the same terminal rejection, not an unhandled promise rejection.

## 3. Run identity (dashboard-event-emission, flow-session-persistence)

- [x] 3.1 `FlowManager.start()` mints the run id (co-located with 2.4), exposes `activeRunId`, passes it to `onFlowStarted`.
- [x] 3.2 `FlowObserver.onFlowStarted` gains `runId` as its first parameter; update both implementors (`EventEmitObserver`, `TuiFlowObserver`).
- [x] 3.3 `EventEmitObserver` stores the runId and stamps it on every core-11 `flow:*` payload; `FlowResult.runId` set on the completion result (then/catch) and on the reconciled orphan result (orphan's id).
- [x] 3.4 `FlowResult` gains `runId?` + `reason?` and status `"rejected"` (`types.ts`).
- [x] 3.5 `FlowEventPersister.persist` records the **supplied** run id from the payload; remove the `randomUUID()` self-mint. Preserve `persistTerminal(orphanId, …)` verbatim.

## 4. Verify

- [x] 4.1 `npm run typecheck` clean; `npm run lint` 0 errors; `npm test` green (343).
- [x] 4.2 `openspec validate report-flow-run-rejection-and-run-identity --strict`.

## 5. Docs (DEFERRED — every `docs/` write must be delegated to a general-purpose subagent per AGENTS.md; not done in the implementation commit)

- [ ] 5.1 `docs/events-api.md`: `flow:run` terminal-rejection contract (`status:"rejected"` + `reason`) and run id on core-11 payloads.
- [ ] 5.2 `docs/public-api.md`: `FlowResult` gains `runId?` / `reason?` / status `"rejected"`.
- [ ] 5.3 `docs/architecture.md`: mint site moves to `FlowManager.start`; persister records the supplied id; reconcile carve-out preserved.
- [ ] 5.4 `CHANGELOG.md`: dispatch terminal rejection + atomic single-run guard + run identity on the live stream.
