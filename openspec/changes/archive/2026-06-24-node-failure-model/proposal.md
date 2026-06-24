# Unified Node Failure Model

## Why

Flow nodes today cannot fail deliberately or stop a flow. `success` is hard-wired to `parsed.status === "complete"` (`execution.ts:615`), agents are *nagged into finishing* via a forced `followUp` retry loop (`execution.ts:530`) instead of being allowed to fail, and a node error with no `on_error` silently continues — there is **no "hard fail that stops the flow"** (the only full stop is user abort). This blocks deterministic pipelines and any flow that needs fail-fast semantics, and it means an unrecoverable infrastructure error (e.g. rate limit after retries) just burns the rest of the flow against a wall.

## What Changes

Establish one failure model for **all** node types, with two deliberate outcomes plus correct handling of infrastructure errors.

- **Two failure modes:**
  - **SOFT** — recoverable; routes to the node's `on_error` and the flow continues.
  - **HARD** — unrecoverable; aborts in-flight parallel steps, skips all pending steps, and ends the flow with status `error` and the failure message surfaced.
- **`on_error` is the soft switch.** A soft-eligible failure with `on_error` set routes there (SOFT). A soft-eligible failure with **no `on_error` hard-fails** the flow (fail-fast by default). **BREAKING (behavioral):** today a failure with no `on_error` silently continues; it will now hard-fail.
- **Transient errors are NOT pi-flows' concern.** pi-coding-agent already auto-retries transient errors (rate limit, 5xx, overloaded, network, timeout) with exponential backoff (`agent-session.js` `_isRetryableError` / `_prepareRetry`, default `maxRetries: 3`, enabled by default). Spawned agents inherit this. pi-flows only ever sees **terminal** agent errors and must not add a redundant retry layer.
- **Agent failures are classified structurally** (no error-message parsing, no deliberate hard signal from the agent):
  - `finish(status:"complete")` → success → `on_complete`.
  - `finish(status:"error" | "blocked")` → SOFT (logical failure the agent reported).
  - no finish **with** an API error (`stopReason:"error"`, i.e. pi's retries exhausted: rate limit / quota / auth) → **HARD** (the provider is unusable; every other agent will hit the same wall).
  - no finish **without** an API error (agent stopped / ran out of turns) → SOFT.
- **No-finish reminder is capped, not infinite.** Replace the open-ended nag with up to **2** reminders that include the `finish` tool-call format; if the agent still does not finish → clean SOFT failure (not `status:"unknown"`, not a loop).
- **Code/extension nodes get an explicit hard signal:** export `FlowHardError` from the package. A plain `throw` (or any non-`FlowHardError` error) is SOFT; `throw new FlowHardError(msg)` is HARD regardless of `on_error`.
- **`success` derivation and routing** are reworked into an explicit outcome (`success | soft | hard`) consumed by the DAG scheduler; HARD short-circuits the run.

## Capabilities

- **New Capabilities:**
  - `node-failure-model` — the outcome taxonomy (success/soft/hard), `on_error`-as-soft-switch resolution, agent structural classification, capped no-finish reminder, `FlowHardError` export, and the hard-fail flow-halt path.

## Impact

- **Affected code:**
  - `execution.ts` — replace the forced finish-retry loop with a capped (≤2) reminder that ends in SOFT failure; derive an explicit failure class (success/soft/hard) including the no-finish-with-API-error → HARD case; stop deriving routing solely from `parsed.status === "complete"`.
  - `flow-execution.ts` — outcome-aware routing: SOFT → `on_error` (or HARD if unset); HARD → abort in-flight siblings, skip pending, end flow status `error` with the message; record the hard-fail reason in the flow result.
  - `types.ts` / package entry — `FlowHardError` class exported; failure-outcome types.
  - `abort-utils.ts` — reuse the abort path for hard-fail (distinct final status `error` vs user `aborted`).
- **Dependents:** `add-code-node` consumes this — its `throw`=SOFT / `FlowHardError`=HARD routing and its "status:error → on_error" scenarios depend on this model existing. `add-code-node` will be updated to reference it.
- **Backward compatibility:** one behavioral break — a soft-eligible failure with no `on_error` now hard-fails instead of silently continuing. This is intentional (fail-fast); flows that relied on silent continuation must add `on_error`. The `finish` schema is unchanged (no new params — classification is structural).
- **Out of scope:**
  - Per-node/per-flow retry knobs for agents (pi already owns transient retry; surfacing a maxRetries override is a separate decision).
  - Code-node retry (deterministic; out of scope here and in add-code-node).
  - Cleanup/finally steps on hard-fail (an `on_error`/cleanup-on-hard-fail hook is a possible future change).
