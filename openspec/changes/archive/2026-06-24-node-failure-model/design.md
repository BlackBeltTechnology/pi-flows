## Context

pi-flows has no deliberate failure model. `success = (parsed.status === "complete")` (`execution.ts:615`); routing is `success ? on_complete : on_error` (`flow-execution.ts:390,442`). Two problems follow: (1) agents are forced toward "complete" by an open-ended finish-retry `followUp` loop (`execution.ts:530`) — they can't cleanly fail; (2) a failure with no `on_error` falls through the `if (routeTarget)` guard and the flow silently continues — there is no "stop the flow on failure" except user abort (`signal.aborted`).

Meanwhile pi-coding-agent already owns transient-error retry: `agent-session.js` `_isRetryableError` (rate limit / 5xx / overloaded / network / timeout) + `_prepareRetry` (exponential backoff, default `maxRetries: 3`, enabled by default), invoked in the session run loop (`agent-session.js:680`). Spawned agents inherit it (`spawnAgent` → `createAgentSession` → `new AgentSession`). So by the time pi-flows sees an agent error, retries are exhausted — the error is terminal.

## Goals / Non-Goals

**Goals:**
- One failure model for all node types: `success` / `soft` / `hard`.
- Fail-fast by default; opt into recovery with `on_error`.
- Let code/extension nodes signal an unconditional hard stop.
- Stop nagging agents; let them fail cleanly.
- Correctly stop the flow on unrecoverable infrastructure errors instead of burning the rest of the run.

**Non-Goals:**
- Re-implementing transient retry (pi owns it).
- Per-node/per-flow agent retry knobs.
- Code-node retry (deterministic).
- Cleanup/finally-on-hard-fail hooks.

## Decisions

### D1 — Three outcomes, resolved centrally
A node resolves to `success | soft | hard`. The scheduler routes: success→`on_complete`, soft→`on_error`, hard→halt. This replaces the boolean `success` + `status === "complete"` routing.

*Why:* the current binary (`success`/not) conflates "the agent reported error" with "the provider is down" with "no `on_error` so do nothing." An explicit three-way outcome lets each failure carry its disposition, computed once, consumed uniformly by every step type.

### D2 — `on_error` is the soft switch; no `on_error` ⇒ hard
A soft-eligible failure routes `on_error` if present, else hard-fails.

*Why:* fail-fast is the safer default — silent continuation (today's behavior) hides bugs and runs work against missing inputs. Making `on_error` the explicit opt-in to recovery means a flow author declares, per node, "this failure is survivable, go here." Absence means "this failure is fatal." This is the one intentional behavioral break.

*Alternative — default soft/continue:* rejected; it's the current footgun (failures vanish).

### D3 — Agent failures classified structurally, not by message
Discriminator: did `finish` fire, with what status, and was there an API error (`stopReason:"error"`)?
- `finish(complete)` → success; `finish(error|blocked)` → soft; no-finish + API error → hard; no-finish + no API error → soft.

*Why:* agents shouldn't *choose* to hard-fail — the error's nature decides. The structural signals are already captured (`finishParams`, `lastApiError`), so no brittle error-string parsing is needed. An API error reaching pi-flows means pi's retries were exhausted (rate limit / quota / auth) — environmental, will recur for every agent → hard. A `finish(error)` means the agent ran and reported a task-level failure → soft.

*Alternative — let agents pass `finish(fatal:true)`:* rejected; agents can't reliably distinguish "my task failed" from "the infra is down," and the infra signal is already observable structurally.

### D4 — Capped no-finish reminder, ending in soft failure
Replace the unbounded `followUp` loop with ≤2 reminders that include the `finish` tool-call format; then a clean soft failure.

*Why:* the format reminder is genuinely useful (agents sometimes forget the schema), but an open-ended loop wastes turns and, on failure, leaves a `status:"unknown"` instead of a real outcome. Two attempts balance help against waste; the terminal state is an honest soft failure.

### D5 — `FlowHardError` for code/extension nodes
Export a `FlowHardError` class. Plain `throw` → soft; `throw new FlowHardError(msg)` → hard (ignores `on_error`).

*Why:* idiomatic JS — authors already express failure by throwing. A marker class is discoverable, typed, and needs no `ctx` surface or YAML config. The default (plain throw = soft) keeps the common case recoverable; hard is a deliberate, visible escalation.

### D6 — Hard-fail reuses the abort path with a distinct final status
Hard failure signals in-flight steps to stop via the existing abort mechanism (`abort-utils`), but the flow's final status is `error` (vs user abort's `aborted`), with the reason recorded in the flow result.

*Why:* the unwinding machinery for stopping parallel work already exists for user abort; hard-fail is the same mechanics with a different terminal label and a surfaced message.

## Risks / Trade-offs

- **Behavioral break (D2):** flows relying on silent continuation now stop. *Mitigation:* documented as intentional; remediation is a one-line `on_error`; surfaced in the proposal's compatibility note.
- **Misclassification of agent errors (D3):** a transient error pi *didn't* classify as retryable could reach pi-flows and be treated as hard. *Mitigation:* pi's retryable set is broad; residual cases are genuinely terminal anyway; the model errs toward stopping rather than looping.
- **Capped reminders (D4):** a borderline agent that would have finished on the 3rd nudge now soft-fails. *Mitigation:* two reminders is generous; a soft failure with `on_error` is recoverable.
- **Hard-fail latency (D6):** in-flight agents abort cooperatively, so a hard fail isn't instantaneous. *Mitigation:* same ceiling as user abort, which is acceptable today.

## Migration Plan

1. Introduce the `success | soft | hard` outcome type and a classifier in `execution.ts` (agent) and the code-node executor (consumed by `add-code-node`).
2. Replace the finish-retry loop with the capped reminder + soft-fail terminal.
3. Rework `flow-execution.ts` routing to consume the outcome: soft→`on_error`-or-hard; hard→abort-and-halt with status `error`.
4. Export `FlowHardError`.
5. Update `add-code-node` to consume the model (done in that change's proposal/spec).
6. Tests per scenario; docs/agent-docs updates delegated per AGENTS.md.

*Rollback:* revert routing to the boolean path and restore the old loop; `FlowHardError` export is inert if unused.

## Open Questions

- Should hard-fail optionally run a designated cleanup step before halting (deferred as a future hook)?
- Should the no-finish reminder count (2) be configurable, or fixed?
- Should pi's agent `maxRetries` be surfaceable per-flow, or left to pi's global settings?
