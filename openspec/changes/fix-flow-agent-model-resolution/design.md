## Context

Flow agent nodes resolve `model:` references in two stages inside `extensions/flow-engine`:

- **Stage 1** — `model-roles.ts::resolveModel(pi, ref, thinking)`: emits `model:resolve` (dashboard handler owns `@role` / providers.json) and, on a silent emit, falls back to `pi.modelRegistry`. Returns `{ modelId, thinking, model }`.
- **Stage 2** — `execution.ts` (~L296–L333): takes only `{ modelId, thinking }`, **throws away `model`**, then re-resolves via `options.modelRegistry.find(provider, id) ?? getAll().find(m => m.id === modelId)`; on miss returns `Failed to resolve model: <modelId>`.

### Corrected root-cause analysis (runtime-verified 2026-07-06)

The earlier diagnosis ("pi 0.80 removed `getModel`, so the registry lookup misses catalog models") is **disproven**:

1. **Registry content is fine.** `ModelRegistry.loadModels()` → `loadBuiltInModels()` → `getProviders().flatMap(getModels)` includes the full pi-ai catalog. A registry constructed exactly as the spawned pi constructs it (pi 0.80.3, real `auth.json`/`models.json`) yields 1029 models and `find("anthropic","claude-opus-4-8"|"claude-sonnet-4-6"|"claude-haiku-4-5")` all return the Model.
2. **Stage 1 works in the failing sessions.** Session JSONL records `"resolvedModel":"anthropic/claude-haiku-4-5"`; the session's own main model is that same id, streaming successfully in the same process.
3. **Failures are uniform across all ids** — 144 occurrences (haiku ×26, sonnet ×111, opus ×7) including ids the process is actively running. Registry-content gaps cannot produce uniform failure; a skipped lookup can: `execution.ts` guards the whole block with `if (options.modelRegistry)`, so an undefined registry falls straight through to the failure return with the *same* error message.
4. **`options.modelRegistry` is the single point of failure.** It is pi-flows' `sessionModelRegistry`, captured once at `session_start` (`index.ts:198`, `if (ctx.modelRegistry)`) with no rescue and no re-capture.
5. **Every documented fallback is dead code under 0.80.** `ExtensionAPI` does not carry `modelRegistry` — only `ExtensionContext` does (`types.d.ts` `ExtensionContext.modelRegistry`; the sole runtime getter sits on `createContext()` in runner.js). Consequences:
   - `model-roles.ts` FALLBACK (`getModelRegistry(pi)` → `(pi as any).modelRegistry`) → always `undefined` → "Model registry unavailable on pi.modelRegistry" (misleading — that property can never exist).
   - The identical helper in pi-dashboard-subagents: same dead read (other repo, out of scope, flagged).
   - pi-agent-dashboard `provider-register.ts` cold-start rescue (`modelRegistryRef ?? piRef.modelRegistry`): second leg dead; only the ctx-event capture works (other repo, out of scope, flagged).
6. **The `model:resolve` PRIMARY path is healthy.** pi's event bus (`event-bus.ts`) wraps handlers in an async `safeHandler` but invokes `handler(data)` synchronously; the dashboard handler sets `probe.model` before its first `await`. Fragile convention, but holds.

### Why the session_start capture misses in headless sessions

Not conclusively established (the ctx getter exists and pi-flows' handler is registered — flow commands work). Candidates: a swallowed exception earlier in the same `session_start` handler, or runner-lifecycle ordering in RPC mode. **The design below makes the answer irrelevant**: capture is refreshed at flow-start time from a ctx that demonstrably exists (the command handler received it), and Stage 2 no longer depends on the registry for the common path at all.

## Goals / Non-Goals

**Goals:**
- Flow agent nodes resolve models in dashboard-spawned headless RPC sessions.
- `options.modelRegistry` is never stale/undefined when the session has a registry.
- Use the `Model` already resolved in Stage 1 end-to-end (including the pre-resolution path).
- A registry-independent last resort (`model:resolve` re-emit) before any hard failure.
- Honest error messages naming the sources actually consulted.

**Non-Goals:**
- No change to the `model:resolve` event contract, `@role` interpretation, or providers.json ownership.
- No fixes to pi-dashboard-subagents / pi-agent-dashboard dead fallbacks (other repos; flagged).
- No upstream pi-coding-agent change (exposing `modelRegistry` on `ExtensionAPI` is a follow-up ask).
- Not addressing the async-contract fragility (sync-mutation-before-`await`); verified holding, tracked separately.

## Decisions

**D1 — Prefer the Stage 1 `Model` object; re-resolution becomes a fallback.**
`execution.ts` destructures `{ modelId, thinking, model }` and uses `model` directly when present. The registry re-resolution runs only when no `Model` is in hand.
Rationale: the redundant second resolution is the failure point; Stage 1 already produced a constructor-ready `Model`. *Alternative considered*: keep discarding and only harden the lookup — rejected, leaves the design smell and the failing path intact.

**D2 — Refresh the registry capture at flow start (primary fix for the observed failure).**
`registerFlowCommand`'s handler and the `flow:run` event handler receive a ctx; capture `ctx.modelRegistry` there (in addition to `session_start`), updating `sessionModelRegistry` before `flowManager.start` reads it via `config.getModelRegistry()`. Where a ctx is unavailable (bare event bus), keep the last captured value.
Rationale: the session_start-only capture is the proven single point of failure; flow-start capture guarantees freshness at the moment it matters. **Note**: a `?? pi.modelRegistry` rescue is NOT viable — the property does not exist on `ExtensionAPI` in 0.80.

**D3 — Thread the `Model` object through the pre-resolution path.**
`flow-execution.ts` pre-resolves (~L673) and currently forwards only the `resolvedModelId` string; `spawnAgent` then must re-derive the Model — this was the production failure path (JSONL shows `resolvedModel` set, then Stage 2 fails). Forward the resolved `Model` object alongside the id (`options.resolvedModel`), making the fallback path exceptional rather than routine.
Rationale: promotes the original proposal's Open Question into scope, because evidence shows it IS the failing path, not an edge case.

**D4 — Stage 2 last resort: re-emit `model:resolve`; catalog backstop demoted to `provider/id` form only.**
When no `Model` is in hand and the registry lookup misses (or registry is absent), call `resolveModel(pi, modelId)` (re-emitting `model:resolve`) before failing. The dashboard handler resolves via its own captured registry — registry-independent from pi-flows' perspective and provably working in the failing sessions. Keep `getBuiltinModelSafe` as the final leg **only** for `provider/id` refs: `getBuiltinModel(provider, modelId)` requires both arguments (`MODELS[provider]?.[modelId]`), so a bare-id catalog lookup is impossible — the original task 1.2 ("strip provider prefix") cannot work.
*Alternative considered*: catalog backstop as the primary fallback (original D2). Demoted — the catalog is version-skewed against `providers.json#roles` (0.75/0.79-era catalogs lack `claude-opus-4-8`) and cannot serve bare ids; the re-emit has neither problem.

**D5 — Correct the fallback error messages.**
`model-roles.ts` errors reference `pi.modelRegistry` ("Model registry unavailable on pi.modelRegistry"), which misdirected the original diagnosis of this change. Errors name what was actually tried: `model:resolve` handler (present/absent), captured session registry (present/absent), catalog backstop (hit/miss/not-applicable).

**D6 — Apply to all Stage 2 sites.**
`flow-execution.ts` passes `modelRegistry` / `resolvedModelId` into the same execution path at three call sites (~L748, L822, L1022); extract a shared `resolveModelObject(...)` helper so faux-testing and normal execution route through one fixed implementation.

## Risks / Trade-offs

- **Stage 1 `Model` and the agent-session's expected `Model` shape differ** → Mitigation: the spec already asserts the Stage 1 Model is constructor-ready; test asserts the same object instance flows through; existing `model-resolution.test.ts` suite runs.
- **Re-emit at Stage 2 duplicates work when the handler is slow** → Mitigation: it runs only on the miss path, which today ends in a hard failure; any latency beats failing.
- **Catalog Model lacks live auth/headers** → Mitigation: auth derives separately from `authStorage` in `execution.ts`, independent of the Model object.
- **`getBuiltinModel` signature drift across pi versions** → Mitigation: isolated in one try/catch helper returning `undefined`; drift degrades to explicit failure, never a crash.
- **Capture-on-every-event adds trivial overhead** → property read + assignment; negligible.

## Migration Plan

1. Add flow-start ctx capture in `index.ts` (D2) — smallest diff, fixes the live failure alone.
2. Rework the `execution.ts` Model block per D1/D4; add `getBuiltinModelSafe` (provider/id only).
3. Thread `resolvedModel` through `flow-execution.ts` (D3, D6 shared helper).
4. Fix `model-roles.ts` error strings (D5).
5. Extend `__tests__/model-resolution.test.ts` for the spec scenarios; `npm test` + `npm run build`.
6. Smoke a real dashboard-spawned headless flow (invoice-bot `invoicebot:process` with `@fast`/`@coding`/`@planning`) → agent nodes run, no `Failed to resolve model`.

Rollback: revert the `index.ts` / `execution.ts` / `flow-execution.ts` / `model-roles.ts` diff; no persisted state or config touched.

## Open Questions

- Exact mechanism of the `session_start` capture miss in headless RPC sessions (made moot by D2/D3, but worth an instrumented repro for pi-coding-agent's benefit).
- Upstream: should pi-coding-agent expose `modelRegistry` on `ExtensionAPI`? Would resurrect all three ecosystems' documented fallbacks in one line; raise as an issue/PR.
- Side finding to verify separately: `getAvailable()` reports zero anthropic models with configured auth in AuthStorage while anthropic sessions stream fine — confirm nothing in the flow path filters on `getAvailable()`.
