## 1. Capture + latch in execution.ts

- [x] 1.1 Replace the `finishParams` / `finishToolCallId` scalars: add `pendingFinishArgs = new Map<string, any>()` and `finishLatched = false`; keep `finishParams` as the frozen result slot.
- [x] 1.2 In the `tool_execution_start` case, for the finish tool record `pendingFinishArgs.set(toolCallId, args)` only — do NOT write `finishParams`.
- [x] 1.3 In the `tool_execution_end` case, for the finish tool: if `finishLatched` → return; else if `!isError` → set `finishParams = pendingFinishArgs.get(toolCallId)`, `finishLatched = true`, `session.abort()`; else (error, not latched) → no-op (no clear, no followUp).
- [x] 1.4 Remove the per-event `session.followUp(...)` and the `finishValidationRetries` clear/increment from the error branch.

## 2. Stop-gate + retry unification

- [x] 2.1 Change the post-prompt reminder loop condition from `!finishParams` to `!finishLatched`; collapse `finishValidationRetries` and `finishRetries` into one stop-gate counter capped by `MAX_FINISH_RETRIES`.
- [x] 2.2 Confirm the tail result-build path: `finishLatched` → use `finishParams`; otherwise `classifyAgentOutcome(undefined)` → `soft`/`agent_no_finish`. Verify the `aborted && !finishParams` user-abort branch is unaffected by a latch-triggered abort.

## 3. Tests

- [x] 3.1 Parallel double-finish (events `start#1, start#2, end#2(error), end#1(success)`): asserts first correct result is latched, duplicate error-end does not clear it, step resolves `success`.
- [x] 3.2 Duplicate-after-correct: a second finish end (success or error) after latch is ignored; `abort()` fires exactly once.
- [x] 3.3 Malformed-then-correct single finish: no followUp from handler; subsequent correct finish latches and ends the step.
- [x] 3.4 Never-finishes: stop-gate re-prompts up to the bound, then resolves `soft`/`agent_no_finish` (no unknown/halt).
- [x] 3.5 Latched abort is not classified as a user abort.

## 4. Verify

- [x] 4.1 Run `npm run typecheck`, `npm run lint`, and `npm test`; all green.
- [ ] 4.2 Re-run the dashboard `test:capabilities` flow scenario that previously halted at `work`; confirm it now flows through `gate`. (Requires live dashboard + real model — not run in this session.)
