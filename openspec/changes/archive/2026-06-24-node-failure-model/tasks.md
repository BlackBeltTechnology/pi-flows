## 1. Outcome model foundation

- [x] 1.1 Add a `FailureOutcome` type (`"success" | "soft" | "hard"`) and a `FailureInfo` shape (outcome, message, source) to `types.ts`
- [x] 1.2 Add a `FlowHardError` class (carries a message) and export it from the package entrypoint
- [x] 1.3 Write unit tests asserting `FlowHardError` is `instanceof Error` and is distinguishable from a plain `Error`

## 2. Agent failure classification (execution.ts)

- [x] 2.1 Write tests for the structural classifier: `finish(complete)`→success; `finish(error|blocked)`→soft; no-finish+`lastApiError`→hard; no-finish+no-apiError→soft
- [x] 2.2 Implement a classifier that maps `finishParams` + `lastApiError` to a `FailureOutcome` (no error-message parsing)
- [x] 2.3 Stop deriving routing from `parsed.status === "complete"` alone; have `spawnAgent` surface the classified outcome on its result

## 3. Capped no-finish reminder (execution.ts)

- [x] 3.1 Write tests: agent that never finishes receives ≤2 reminders then resolves SOFT (not `status:"unknown"`); agent that finishes after a reminder succeeds
- [x] 3.2 Replace the unbounded finish-retry `followUp` loop (`execution.ts:530`) with a ≤2 reminder loop whose message includes the `finish` tool-call format
- [x] 3.3 On reminder exhaustion, resolve the node as a clean SOFT failure with a descriptive message

## 4. Outcome-aware routing & flow halt (flow-execution.ts)

- [x] 4.1 Write tests: soft failure with `on_error` routes there; soft failure WITHOUT `on_error` hard-fails the flow; success routes `on_complete`
- [x] 4.2 Replace the `success ? on_complete : on_error` routing with outcome-aware routing (success→on_complete, soft→on_error-or-hard, hard→halt)
- [x] 4.3 Implement the hard-fail halt: signal in-flight parallel steps via the existing abort path, skip pending steps, end the flow with final status `error`
- [x] 4.4 Record the hard-fail reason in the flow result (distinct from user `aborted`) so the main session can read it
- [x] 4.5 Write tests: hard failure aborts running siblings, skips pending, and the flow result carries status `error` + message

## 5. Transient-retry boundary

- [x] 5.1 Confirm (and add a regression test/assertion) that pi-flows adds NO retry for agent errors — errors reaching the engine are treated as terminal and classified per section 2

## 6. Integration & verification

- [x] 6.1 End-to-end test: a flow where a node soft-fails with `on_error` continues; the same node without `on_error` stops the flow
- [x] 6.2 End-to-end test: a `FlowHardError` thrown from a code/extension node stops the flow regardless of `on_error`
- [x] 6.3 Run `npm run lint`, `npm run typecheck`, and `npm test`; fix fallout

## 7. Documentation

- [x] 7.1 Delegate docs updates to a subagent: `docs/flows.md` (failure modes, on_error-as-soft-switch, hard vs soft) and `docs/public-api.md` (`FlowHardError`)
- [x] 7.2 Delegate the caveman mirror to a subagent: `agent-docs/flows.md` and `agent-docs/public-api.md`
- [x] 7.3 Note the behavioral break (no `on_error` ⇒ hard-fail) in `CHANGELOG.md`
