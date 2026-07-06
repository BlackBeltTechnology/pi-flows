## ADDED Requirements

### Requirement: Flow start SHALL capture a fresh model registry from the dispatch context

pi-flows SHALL refresh its captured model registry (`sessionModelRegistry`) from `ctx.modelRegistry` at every extension entry point that receives an `ExtensionContext` — including the flow slash-command handler and the `flow:run` event path — in addition to the existing `session_start` capture. `flowManager.start` SHALL therefore never observe an undefined/stale registry when the hosting session has one. The capture MUST NOT rely on `pi.modelRegistry`: that property does not exist on `ExtensionAPI` in pi-coding-agent 0.80 (only `ExtensionContext` carries `modelRegistry`).

#### Scenario: Flow dispatched in a headless session where the session_start capture missed

- **GIVEN** a dashboard-spawned headless RPC session whose `session_start` capture left `sessionModelRegistry` undefined
- **WHEN** the operator (or automation prompt) runs a flow command whose handler receives a ctx with `ctx.modelRegistry`
- **THEN** pi-flows SHALL capture that registry before `flowManager.start` reads `config.getModelRegistry()`
- **AND** agent nodes SHALL resolve models without `Failed to resolve model` errors

#### Scenario: No ctx available at dispatch

- **GIVEN** a flow started via a bare event-bus path that carries no `ExtensionContext`
- **WHEN** the flow starts
- **THEN** the last successfully captured registry SHALL be used unchanged

### Requirement: Flow execution SHALL use the Stage 1 resolved Model directly

Flow execution SHALL consume the `Model` object returned by Stage 1 (`resolveModel(pi, ref, thinking)`) directly whenever it is present, and SHALL NOT discard that `Model` and re-resolve `modelId` against `options.modelRegistry`.

The pre-resolution path SHALL carry the `Model` object: when `flow-execution.ts` pre-resolves an agent's model, it SHALL forward the resolved `Model` alongside the id (not the id string alone), so `spawnAgent` constructs the session from the already-resolved object.

#### Scenario: Resolved Model from Stage 1 is used without re-resolution

- **GIVEN** an agent definition `model: "@fast"` that Stage 1 resolves to `{ modelId: "anthropic/claude-haiku-4-5", model: <Model> }`
- **WHEN** flow execution builds the agent session
- **THEN** the `<Model>` object from Stage 1 SHALL be used directly to construct the agent session
- **AND** flow execution SHALL NOT call `options.modelRegistry.find("anthropic", "claude-haiku-4-5")` a second time
- **AND** the node SHALL NOT fail with `Failed to resolve model`

#### Scenario: Pre-resolved agent carries the Model object through to spawn

- **GIVEN** a flow whose pre-resolution step resolved `@coding` to `{ modelId: "anthropic/claude-sonnet-4-6", model: <Model> }`
- **WHEN** the step's agent is spawned
- **THEN** `spawnAgent` SHALL receive and use the `<Model>` object
- **AND** the Stage 2 registry lookup SHALL NOT run for that agent

### Requirement: Stage 2 re-resolution SHALL be a guarded fallback chain

The id→Model re-resolution SHALL run ONLY when no `Model` object is in hand (legacy pre-resolved-id callers supplying only `options.resolvedModelId`). Its fallback order SHALL be:

1. `options.modelRegistry.find(provider, id)` / `getAll()` bare-id match (when a registry is present),
2. a re-emit of `model:resolve` via `resolveModel(pi, modelId)` (registry-independent; the handler resolves via its own captured registry),
3. for `provider/id` refs only: a pi-ai catalog lookup via `getBuiltinModel(provider, id)` from the `/compat` entry (the function requires both arguments; bare ids skip this leg),
4. hard failure with `Failed to resolve model: <modelId>` and `isError: true`.

#### Scenario: Registry absent, handler resolves via re-emit

- **GIVEN** `options.resolvedModelId === "anthropic/claude-haiku-4-5"`, no `Model` in hand, AND `options.modelRegistry` undefined
- **WHEN** flow execution resolves the Model
- **THEN** flow execution SHALL re-emit `model:resolve` and use the handler-resolved `Model`
- **AND** the node SHALL NOT fail with `Failed to resolve model`

#### Scenario: Registry misses, catalog backstop hits (provider/id form)

- **GIVEN** `options.resolvedModelId === "anthropic/claude-opus-4-8"`, no `Model` in hand, registry and re-emit both miss, AND the pi-ai catalog defines `anthropic`/`claude-opus-4-8`
- **WHEN** flow execution resolves the Model
- **THEN** the catalog Model from `getBuiltinModel("anthropic", "claude-opus-4-8")` SHALL be used

#### Scenario: Bare id skips the catalog leg

- **GIVEN** a pre-resolved bare id `"claude-haiku-4-5"` (no provider segment) where registry and re-emit both miss
- **WHEN** flow execution resolves the Model
- **THEN** the catalog leg SHALL be skipped (no provider to key `MODELS[provider]`)
- **AND** the failure message SHALL note that bare ids cannot use the catalog backstop

#### Scenario: All legs miss

- **GIVEN** a pre-resolved id `"vendor/made-up-model"` unknown to the registry, the `model:resolve` handler, and the catalog
- **WHEN** flow execution resolves the Model
- **THEN** the agent invocation SHALL fail with `isError: true`
- **AND** the failure summary SHALL be `Failed to resolve model: vendor/made-up-model`

### Requirement: Fallback error messages SHALL name the sources actually consulted

Model-resolution failure messages SHALL enumerate which sources were consulted and their outcome (handler answered/silent, captured registry present/absent/miss, catalog hit/miss/not-applicable) and SHALL NOT reference `pi.modelRegistry` (nonexistent on `ExtensionAPI` in pi-coding-agent 0.80).

#### Scenario: Silent emit with no captured registry

- **GIVEN** no `model:resolve` handler is registered AND no registry has been captured
- **WHEN** `resolveModel(pi, "anthropic/claude-haiku-4-5")` runs its fallback
- **THEN** the error SHALL state that the `model:resolve` emit was unanswered and no session registry was captured
- **AND** the error SHALL NOT claim a missing `pi.modelRegistry` property
