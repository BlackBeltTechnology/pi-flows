## Context

Agent steps end when the harness observes a `finish` tool call and reacts with `session.abort()` — `finish` is advisory, not a hard loop terminator (its `execute()` returns no `terminate` flag, and no `shouldStopAfterTurn` watches it). Today `extensions/flow-engine/execution.ts` captures the result in two mutable scalars, `finishParams` and `finishToolCallId`, updated on `tool_execution_start` and reacted to on `tool_execution_end`.

pi-agent-core's `executeToolCallsParallel` emits **all** `tool_execution_start` events up front in a for-loop, then runs executions in a deferred `Promise.all`. For a single assistant message carrying two `finish` calls, the observed event order is:

```
start#1  start#2  end#2(error, blocked by guard)  end#1(success)
```

With the current logic this sequence: (1) `start#2` overwrites the good args captured at `start#1`; (2) `end#2`'s `isError` branch sets `finishParams = undefined`, clears `finishToolCallId`, and queues a "schema validation failed" followUp; (3) `end#1`'s success branch finds `finishToolCallId` already nulled, so `session.abort()` never fires. Net: the legitimate result is destroyed, the step ends non-`complete`, and `classifyAgentOutcome(undefined)` yields `soft`/`agent_no_finish` → a flow without `on_error` halts.

## Goals / Non-Goals

**Goals:**
- A correct `finish` is captured exactly once and frozen; duplicates and malformed attempts can never overwrite or erase it.
- The step stops deterministically after the first correct `finish`.
- Re-prompting happens only when no correct `finish` has been latched, driven at a single stop-gate.
- Fix is localized to `execution.ts`; no changes to pi-agent-core dispatch semantics.

**Non-Goals:**
- Preventing the model from emitting duplicate `finish` calls (model behavior).
- Changing batch execution order or making `finish` `executionMode: "sequential"` or `terminate: true` (heavier alternatives, see Decisions).
- Altering `classifyAgentOutcome` or `node-failure-model` routing.

## Decisions

**D1 — Capture on `tool_execution_end`, keyed by `toolCallId`.** Stop capturing args on `tool_execution_start`. Record pending args in a `Map<toolCallId, args>` at start, and only read from it when the matching `end` arrives. This removes the start-event clobber, because no end event consults another call's args.

*Alternative considered:* keep capturing at start but ignore later starts once set. Rejected — still couples the captured value to event ordering and leaves the error-end clear path intact.

**D2 — First-correct-finish-wins latch.** Add `finishLatched: boolean`. On a `finish` `tool_execution_end`: if already latched, ignore; else if `!isError`, set `finishParams` from the pending map, set `finishLatched = true`, and call `session.abort()` once; else (error, not latched) do nothing in the handler. This makes the duplicate's error-end inert and guarantees the good success-end wins regardless of arrival order.

*Alternative considered:* `finish.execute()` returns `terminate: true`. Rejected — `shouldTerminateToolBatch` requires *every* call in the batch to terminate, so a mixed `finish + other` or `finish + blocked-finish` batch never terminates. Session-level `abort()` tied to the latch is order- and batch-shape-independent.

**D3 — No followUp from the event handler.** Remove the per-event `session.followUp(...)` in the error branch. Because the duplicate's error-end precedes the real success-end, any per-event retry fires prematurely and is misleading ("schema validation" for a duplicate block). The decision to re-prompt is deferred to the stop-gate where the final state (`finishLatched`) is known.

**D4 — Stop-gate keyed on `finishLatched`.** The post-prompt reminder loop changes its condition from `!finishParams` to `!finishLatched`. A genuinely malformed single `finish` still self-corrects: the model receives the schema-error tool result and retries naturally within the same `prompt()` (the loop continues since `finish` has no `terminate`). The stop-gate only nags when the agent stops without ever latching a correct finish, bounded by a single retry counter.

**D5 — Retain the guard block; unify retry counters.** The `beforeToolCall` guard that blocks the duplicate finish stays for model feedback but is now correctness-irrelevant. The two existing counters (`finishValidationRetries`, `finishRetries`) collapse into one stop-gate counter, since the schema-error retry is now handled by the model's natural retry path rather than an explicit per-event followUp.

## Risks / Trade-offs

- **A latch-triggered abort must not be mistaken for a user abort** → the tail's `aborted && !finishParams` branch is unaffected because a latched abort always leaves `finishParams` set; verify with a test.
- **A malformed single finish no longer gets an explicit followUp from the handler** → relies on the model seeing the error tool result and retrying, plus the stop-gate as backstop. Covered by a malformed-then-correct test.
- **Token/`onAssistantText` side effects after a latched finish still fire on the aborted next turn** → unchanged, cosmetic only (rendered, not used for the result). Out of scope.
- **Map of pending args grows with finish attempts** → bounded by the small number of finish calls per step; cleared with the session. Negligible.

## Open Questions

- Should the stop-gate followUp message distinguish "you never called finish" from "your finish was malformed"? Current plan: one message; revisit if it confuses models.
