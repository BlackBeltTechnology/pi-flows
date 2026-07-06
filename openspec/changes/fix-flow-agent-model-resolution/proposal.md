## Why

Flow agent nodes in dashboard-spawned (headless RPC) sessions hard-fail with `Failed to resolve model: <provider/id>` — 144 occurrences across invoice-bot-test sessions (`@fast`→`anthropic/claude-haiku-4-5` ×26, `@coding`→`anthropic/claude-sonnet-4-6` ×111, `@planning`→`anthropic/claude-opus-4-8` ×7), still reproducing on pi-coding-agent 0.80.3.

The root cause is **not** registry content and **not** the removed pi-ai `getModel` helper (the earlier diagnosis). Runtime verification proved:

- A `ModelRegistry` built exactly as the spawned pi builds it (real `auth.json`/`models.json`, pi 0.80.3) holds 1029 models and `find()` resolves **all three failing ids** — `loadBuiltInModels()` includes the full pi-ai catalog.
- Stage 1 resolution **works** in the failing sessions: the JSONL records `"resolvedModel":"anthropic/claude-haiku-4-5"`, and the session's own main model is that same id, running fine in the same process.
- Failures are **uniform across all ids** — including the id the session itself is actively running. Only a missing/unusable `options.modelRegistry` produces that pattern: Stage 2's lookup block (`if (options.modelRegistry) …`) is skipped entirely and the node falls through to the failure return.

`options.modelRegistry` is pi-flows' `sessionModelRegistry`, captured **once** at `session_start` (`index.ts:198`) with **no fallback**. And every documented fallback in the chain reads `pi.modelRegistry` — a property that **does not exist on `ExtensionAPI` in 0.80** (only `ExtensionContext` carries `modelRegistry`; verified in `types.d.ts` and runner.js — the sole getter is on `createContext()`). The Stage 1 emitter fallback in `model-roles.ts` and the same helper in pi-dashboard-subagents are dead code; when the capture misses, nothing rescues Stage 2.

## What Changes

- **Registry capture becomes robust**: pi-flows SHALL refresh `sessionModelRegistry` from `ctx.modelRegistry` on every extension event it handles — critically including the flow command handler / `flow:run` dispatch context at flow-start time — so `options.modelRegistry` is never stale or undefined when a session has a registry.
- **Flow execution SHALL use the `Model` object already returned by `resolveModel()`** instead of re-resolving `modelId` against `options.modelRegistry` (unchanged from the original proposal — still correct and required).
- **The pre-resolution path SHALL carry the `Model` object**: `flow-execution.ts` currently pre-resolves and passes only the `resolvedModelId` string into `spawnAgent`, forcing the fragile Stage 2 lookup. It passes the resolved `Model` alongside the id (this was the failing path in production).
- **Stage 2 last-resort fallback**: when no `Model` is in hand and the registry lookup misses (or the registry is absent), flow execution SHALL re-emit `model:resolve` before failing — the handler path is registry-independent from pi-flows' perspective and provably works. A pi-ai `getBuiltinModel` catalog backstop is retained only for the `provider/id` form (the function requires a provider; a bare-id catalog lookup is impossible).
- **Error messages corrected**: the `model-roles.ts` fallback errors reference `pi.modelRegistry`, which no longer exists — misleading operators (and the original diagnosis of this very change). Messages SHALL name the actual sources tried.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `flow-model-resolution`: registry capture is refreshed at flow start; the Stage 1 `Model` object is used directly and carried through the pre-resolution path; the id→Model re-resolution is a fallback only, backed by a `model:resolve` re-emit and (for `provider/id` form) a catalog backstop; fallback error messages name the sources actually consulted.

## Impact

- **Code**: `extensions/flow-engine/index.ts` (registry capture, ~L196–199 + flow command handler + `flow:run`), `extensions/flow-engine/execution.ts` (Model resolution block ~L296–L333), `extensions/flow-engine/flow-execution.ts` (pre-resolution + `resolvedModelId`/`modelRegistry` pass-through at ~L673, L748, L822, L1022), `extensions/flow-engine/model-roles.ts` (error strings).
- **Dependency**: `@earendil-works/pi-ai` `getBuiltinModel` via the `/compat` entry (still exported in 0.80) for the demoted catalog backstop.
- **Behavior**: flow agent nodes resolve models in dashboard-spawned headless sessions again; no user-facing config change; roles/providers.json untouched.
- **Out of scope**:
  - The dead `pi.modelRegistry` read in pi-dashboard-subagents' `resolveModelFromRef` and in pi-agent-dashboard's `provider-register.ts` cold-start rescue (same 0.80 regression, other repos — flagged to their owners).
  - Upstream ask: pi-coding-agent exposing `modelRegistry` on `ExtensionAPI` (one-line getter on the runner) would resurrect all documented fallbacks at once.
  - The async-contract fragility of `model:resolve` (sync-mutation-before-`await` invariant) — holds today (the event bus invokes handlers synchronously), tracked separately.
