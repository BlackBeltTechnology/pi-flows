## Why

When an agent step's model emits two `finish` tool calls in a single assistant message (a parallel tool batch), the harness in `extensions/flow-engine/execution.ts` captures the result in a single mutable slot that the second (duplicate) call clobbers and then erases. The duplicate's error-end clears `finishParams` and skips `session.abort()`, so the legitimate first result is lost, the step ends non-`complete` ("unknown"), and a flow with no `on_error` halts before its next step ever runs. The model misbehavior is the trigger; the fragile single-slot capture is the root defect.

## What Changes

- Capture `finish` arguments on `tool_execution_end` (keyed by `toolCallId`) instead of on `tool_execution_start`, so a later finish call's start event can no longer overwrite a good capture.
- Introduce a **first-correct-finish-wins latch**: the first successful (`isError === false`) `finish` end freezes `finishParams`, fires `session.abort()` once, and all subsequent `finish` ends — success or error — are ignored.
- Stop firing `followUp` from inside the per-event finish handler. A duplicate's error-end (which arrives *before* the real success-end in a parallel batch) must no longer queue a spurious "schema validation failed" retry.
- Move the "no valid finish → re-prompt" decision entirely to the post-prompt **stop-gate**, keyed on the latch (`finishLatched`) rather than on the clobber-prone `finishParams`. Malformed single finishes continue to self-correct via the model's natural retry on the returned error tool result.
- The `beforeToolCall` guard that blocks the duplicate finish stays (now harmless — it only provides model feedback). Retry counters that currently split across two paths are unified onto the single stop-gate counter.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-node`: the `finish` capture/stop contract changes — first correct finish is latched-once-and-frozen and ends the step via abort; duplicate or malformed finishes can never overwrite or erase the latched result; the followUp/retry path is driven by the absence of a latched finish, not by per-event errors.

## Impact

- **Code:** `extensions/flow-engine/execution.ts` (finish capture in the `session.subscribe` handler + the post-prompt reminder loop). No change to `guard.ts` behavior is required, though the block becomes inert for correctness.
- **Behavior:** double-finish steps now resolve to the first correct result instead of halting; genuine no-finish/stall still fails as a clean `soft`/`agent_no_finish` via `classifyAgentOutcome`.
- **Tests:** `__tests__/` gains coverage for parallel double-finish (first wins), duplicate-after-correct ignored, malformed-then-correct retry, and never-finishes stop-gate.
- **Dependencies:** none. Relies on existing pi-agent-core event ordering (`start`s before deferred `end`s in `executeToolCallsParallel`).
