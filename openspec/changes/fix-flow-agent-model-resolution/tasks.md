## 1. Registry capture at flow start (primary fix — D2)

- [ ] 1.1 In `extensions/flow-engine/index.ts`, extract a `captureFromCtx(ctx)` helper that sets `sessionModelRegistry` / `sessionAuthStorage` when `ctx.modelRegistry` is present (keep the existing `session_start` call site).
- [ ] 1.2 Call `captureFromCtx(ctx)` at the top of every `registerFlowCommand` handler invocation (the command handler receives a ctx) and in the second `session_start` handler (~L365), before `flowManager.start` runs.
- [ ] 1.3 Audit remaining `pi.on(...)` handlers in `index.ts` that receive a ctx; add the capture where present. Do NOT add any `pi.modelRegistry` read (property does not exist on `ExtensionAPI` in 0.80).

## 2. Use Stage 1 Model in execution.ts (D1, D4)

- [ ] 2.1 In `execution.ts` (~L270–L333), destructure `model` from `resolveModel(...)` alongside `modelId`/`thinking` and use it directly when present; DELETE the unconditional registry re-resolution for that path.
- [ ] 2.2 Accept a new `options.resolvedModel?: Model` (paired with `options.resolvedModelId`) and prefer it over any lookup.
- [ ] 2.3 Fallback chain for the id-only path, in order: registry `find`/`getAll` → re-emit via `resolveModel(pi, modelId)` (try/catch; a throw counts as a miss) → `getBuiltinModelSafe(provider, id)` for `provider/id` refs only → existing `Failed to resolve model: <modelId>` failure shape.
- [ ] 2.4 Add `getBuiltinModelSafe(provider: string, id: string): Model | undefined` importing `getModel`/`getBuiltinModel` from `@earendil-works/pi-ai/compat`, try/catch returning `undefined`. No bare-id variant (function requires the provider argument).

## 3. Thread the Model through pre-resolution (D3, D6)

- [ ] 3.1 In `flow-execution.ts` (~L673), keep the resolved `Model` object from the pre-resolution `resolveModel(...)` call and pass it as `resolvedModel` into the three `spawnAgent` call sites (~L748, L822, L1022).
- [ ] 3.2 Extract a shared `resolveModelObject(...)` helper if the fallback chain would otherwise be duplicated across call sites.
- [ ] 3.3 Confirm `authStorage`-based auth derivation is unchanged (catalog- or handler-sourced Model must not regress auth).

## 4. Error-message correction (D5)

- [ ] 4.1 In `model-roles.ts`, rewrite the fallback error strings: report `model:resolve` emit outcome (answered/silent/threw), captured-registry state (present/absent/miss), and catalog applicability — remove every mention of `pi.modelRegistry`.
- [ ] 4.2 Mirror the corrected wording in the Stage 2 failure message in `execution.ts` (which legs were tried).

## 5. Tests

- [ ] 5.1 `__tests__/model-resolution.test.ts`: Stage 1 `model` reused without a second `registry.find` call (spy asserts zero calls).
- [ ] 5.2 New capture test: flow dispatch with a ctx refreshes `sessionModelRegistry` when the `session_start` capture was skipped (simulated undefined initial capture).
- [ ] 5.3 Pre-resolved path: `resolvedModel` object passed through `spawnAgent` → no registry lookup runs.
- [ ] 5.4 Id-only path with registry undefined → re-emit resolves via handler stub → node succeeds (regression test for the production failure).
- [ ] 5.5 Id-only path, registry + re-emit miss, `provider/id` form → `getBuiltinModelSafe` resolves (e.g. `anthropic/claude-opus-4-8`).
- [ ] 5.6 Bare-id form skips the catalog leg; failure message notes it.
- [ ] 5.7 All legs miss → `Failed to resolve model: <id>` with `isError: true`.
- [ ] 5.8 Error-string tests: no `pi.modelRegistry` mention; sources-tried enumeration present.

## 6. Validate

- [ ] 6.1 `npm test` green (new + existing `model-resolution` suite).
- [ ] 6.2 `npm run build` / typecheck clean (confirm `/compat` import resolves under base tsconfig).
- [ ] 6.3 Smoke the real failing scenario: dashboard-spawned headless session in an invoice-bot checkout running `invoicebot:process` with `@fast`/`@coding`/`@planning` → agent nodes run, zero `Failed to resolve model` in the session JSONL.
