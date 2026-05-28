# flow-model-resolution Specification

## Purpose

Defines how pi-flows resolves `model:` references found in agent definitions and flow YAML into concrete `Model` objects passed to pi-coding-agent's agent-session constructor.

pi-flows is a **consumer** of the shared `model:resolve` event: it emits a probe and reads the result. The event handler (typically pi-agent-dashboard) owns interpretation of `@role` prefixes, the `:thinking` suffix, and `~/.pi/agent/providers.json#roles`. When no handler answers, pi-flows falls back to in-process `pi.modelRegistry` resolution for the two literal forms (`provider/model[:thinking]` and bare `model-id[:thinking]`) and refuses `@role` with an actionable error.

## Requirements

### Requirement: pi-flows SHALL resolve `model:` references via the shared `model:resolve` event

When the flow engine encounters a `model:` field in an agent definition or flow YAML, it SHALL emit `pi.events.emit("model:resolve", probe)` exactly once with a probe object of shape:

```
{ ref: string, resolved?: string, model?: Model, thinkingLevel?: ThinkingLevelString, auth?: object, error?: string, available?: { roles?, models? } }
```

After the emit returns, the flow engine SHALL read `probe.model`, `probe.thinkingLevel`, and `probe.error` synchronously. The handler is responsible for handling all three input forms (`@role`, `provider/model[:thinking]`, bare `model-id`) transparently. The flow engine itself SHALL NOT attempt to interpret `@role` prefixes, parse provider/model separators, or read `providers.json` — that is the handler's responsibility.

#### Scenario: Event handler resolves @role to a Model

- **GIVEN** an agent definition `model: "@coding"` AND a `model:resolve` handler is registered
- **WHEN** the flow engine resolves the model reference
- **THEN** `pi.events.emit("model:resolve", probe)` SHALL be called exactly once with `probe.ref === "@coding"`
- **AND** after the emit returns, `probe.model` SHALL be a Model object
- **AND** the resulting Model SHALL be passed to pi-coding-agent's agent-session constructor along with `probe.thinkingLevel`

#### Scenario: Event handler resolves literal provider/model

- **GIVEN** an agent definition `model: "anthropic/claude-opus-4"` AND a handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the emit SHALL be made with `probe.ref === "anthropic/claude-opus-4"`
- **AND** the handler SHALL fill `probe.model` via the registry
- **AND** the in-process fallback SHALL NOT run

#### Scenario: Event handler resolves bare model id

- **GIVEN** an agent definition `model: "claude-haiku-4-5"` (no `/`, no `@`) AND a handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the emit SHALL be made and the handler SHALL fill `probe.model` via a "like" query against the registry
- **AND** the resolved Model's id SHALL equal `"claude-haiku-4-5"`

#### Scenario: Thinking suffix is parsed by the handler and surfaced via probe.thinkingLevel

- **GIVEN** an agent definition `model: "anthropic/claude-haiku-4-5:high"` AND a handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the handler SHALL set `probe.thinkingLevel === "high"` and `probe.resolved === "anthropic/claude-haiku-4-5"`
- **AND** the flow engine SHALL pass `thinkingLevel: "high"` to the agent session in addition to the Model

#### Scenario: Handler error surfaces in flow execution

- **GIVEN** an agent definition `model: "@unknownrole"` AND a handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the handler SHALL set `probe.error` to a human-readable string and MAY set `probe.available.roles`
- **AND** the flow engine SHALL fail the affected agent invocation with a clear error that includes the handler-supplied message and the agent definition's source (file path or flow name)

### Requirement: pi-flows SHALL fall back to in-process `pi.modelRegistry` resolution when no `model:resolve` handler answers

When the `model:resolve` emit returns with both `probe.model` and `probe.error` unset (silent emit — no handler reacted), the flow engine SHALL attempt in-process resolution using `pi.modelRegistry`. The fallback SHALL handle the two literal forms (`provider/model[:thinking]` and bare `model-id[:thinking]`) but SHALL NOT attempt `@role` lookup.

The fallback SHALL parse the `:thinking` suffix before any registry lookup, then:

- If the literal contains `/`, split into provider + id and call `registry.find(provider, id)`.
- Otherwise treat as a bare id and call `registry.getAll().find(m => m.id === literal)`.

On success, the fallback SHALL pass the resolved Model and thinking level to the agent session. On failure (no match for a literal, OR an `@role` reference), the agent invocation SHALL fail with `isError: true` and a structured error.

#### Scenario: Fallback resolves literal provider/model without a handler

- **GIVEN** an agent definition `model: "anthropic/claude-opus-4"` AND NO `model:resolve` handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the emit SHALL be silent (no listener)
- **AND** the flow engine SHALL call `pi.modelRegistry.find("anthropic", "claude-opus-4")`
- **AND** the resulting Model SHALL be used to instantiate the agent session

#### Scenario: Fallback resolves bare model id without a handler

- **GIVEN** an agent definition `model: "claude-haiku-4-5"` AND NO handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the flow engine SHALL call `pi.modelRegistry.getAll().find(m => m.id === "claude-haiku-4-5")`
- **AND** the first matching Model in iteration order SHALL be used

#### Scenario: Fallback refuses @role with actionable error

- **GIVEN** an agent definition `model: "@coding"` AND NO `model:resolve` handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the in-process fallback SHALL NOT attempt to read `~/.pi/agent/providers.json`
- **AND** the affected agent invocation SHALL fail with `isError: true`
- **AND** the error message SHALL state that `@role` resolution requires a `model:resolve` handler
- **AND** the error message SHALL suggest installing or enabling pi-agent-dashboard

#### Scenario: Fallback reports unknown literal with available models hint

- **GIVEN** an agent definition `model: "made-up-model"` AND NO handler AND no registry match
- **WHEN** the fallback runs
- **THEN** the agent invocation SHALL fail with `isError: true`
- **AND** the error message SHALL name the unresolved ref
- **AND** the error message SHALL include up to twenty known model ids from the registry as a hint

### Requirement: `resolveModel` SHALL no longer depend on a `getModelRole` parameter

The exported helper at `extensions/flow-engine/model-roles.ts::resolveModel` SHALL accept a `pi: ExtensionAPI` handle in lieu of the prior `getModelRole` callback parameter. The new signature is `resolveModel(pi, modelRef, thinkingLevel)`. All four current call sites (`execution.ts`, `flow-execution.ts`, two in `flow-workspace/index.ts`) SHALL be updated to the new signature.

The exported `getModelRole` symbol SHALL be removed from `extensions/flow-engine/index.ts` (the re-export barrel). pi-flows SHALL retain no public surface area for direct in-process role lookup.

#### Scenario: resolveModel emits model:resolve

- **WHEN** flow execution calls `resolveModel(pi, agentConfig.model, agentConfig.thinking)`
- **THEN** the implementation SHALL call `pi.events.emit("model:resolve", { ref: agentConfig.model })`
- **AND** SHALL return the resolved `{ modelId, thinkingLevel, model }` shape consistent with existing callers

#### Scenario: getModelRole is no longer exported

- **WHEN** any module imports from `@blackbelt-technology/pi-flows/extensions/flow-engine`
- **THEN** the `getModelRole` symbol SHALL NOT be exported
- **AND** the package's typecheck SHALL fail for any callsite that still imports it

### Requirement: pi-flows SHALL NOT register a `model:resolve` handler

pi-flows SHALL be exclusively a CONSUMER of `model:resolve`, not a provider. The package SHALL NOT call `pi.events.on("model:resolve", …)` from any module.

#### Scenario: No handler registration at activation

- **WHEN** pi-flows' `activate(pi)` runs
- **THEN** there SHALL be no `pi.events.on("model:resolve", …)` invocation in any extension module
- **AND** a codebase grep for `events.on("model:resolve"` SHALL return zero hits inside `extensions/`

### Requirement: pi-flows SHALL NOT own `~/.pi/agent/providers.json#roles`

The file `extensions/role-manager.ts` SHALL be removed. pi-flows SHALL NOT read, write, or otherwise interpret the `roles` section of `~/.pi/agent/providers.json`. The `flow:role-set`, `flow:role-get-all`, `flow:role-preset-load`, `flow:role-preset-save`, and `flow:role-preset-delete` event handlers SHALL be removed from pi-flows; ownership transfers to the pi-agent-dashboard companion change.

The autonomous-mode toggle (currently bundled with role state under `providers.json#autonomousMode`) SHALL move to a new module `extensions/autonomous-mode.ts` and continue to read/write the same on-disk key. Its API (`isAutonomousMode()`, `setAutonomousMode(enabled)`) SHALL be preserved bit-for-bit.

#### Scenario: role-manager.ts is removed

- **WHEN** the pi-flows package is built and tested
- **THEN** `extensions/role-manager.ts` SHALL not exist
- **AND** no module under `extensions/` SHALL contain a `require` or `import` of `role-manager`
- **AND** the npm-pack tarball SHALL NOT include any file named `role-manager.*`

#### Scenario: autonomous-mode state is preserved

- **GIVEN** an existing `~/.pi/agent/providers.json` with `autonomousMode: true`
- **WHEN** pi-flows activates
- **THEN** `isAutonomousMode()` SHALL return `true`
- **AND** `setAutonomousMode(false)` SHALL persist `autonomousMode: false` to the SAME on-disk file
- **AND** any preexisting `roles` / `rolePresets` / `activePreset` fields in the file SHALL NOT be touched by pi-flows

### Requirement: The flow-architect prompt SHALL teach all three `model:` reference forms

The system prompt in `agents/flow-architect.md` SHALL document the three accepted `model:` field forms with examples, so the architect can generate agent definitions using any form (not only `@role`). The prompt SHALL state which form is preferred (`@role`) and when the others are appropriate.

#### Scenario: All three forms are documented in the architect's prompt

- **WHEN** a developer reads `agents/flow-architect.md`
- **THEN** the prompt body SHALL include a section listing the three forms: `@role`, `provider/model[:thinking]`, and bare `model-id`
- **AND** the section SHALL include one example of each form
- **AND** the section SHALL state that `@role` is the preferred default
- **AND** the section SHALL state that `provider/model` and bare `model-id` are appropriate when (a) a specific model is required regardless of role config, or (b) the user explicitly asks for a non-role model

#### Scenario: Generated agent definitions can use any form

- **GIVEN** the architect has been told "make me an agent that always uses anthropic/claude-haiku-4-5:high"
- **WHEN** the architect generates the agent's frontmatter
- **THEN** the generated `model:` field MAY contain the literal `"anthropic/claude-haiku-4-5:high"`
- **AND** the resulting file SHALL be valid YAML and SHALL resolve correctly at runtime via the new resolveModel implementation
