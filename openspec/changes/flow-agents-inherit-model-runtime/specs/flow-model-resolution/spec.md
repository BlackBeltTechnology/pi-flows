## MODIFIED Requirements

### Requirement: pi-flows SHALL fall back to in-process `pi.modelRegistry` resolution when no `model:resolve` handler answers

When the `model:resolve` emit returns with both `probe.model` and `probe.error` unset (silent emit — no handler reacted), the flow engine SHALL attempt in-process resolution using the **session's model registry**: the `ctx.modelRegistry` captured from the most recent `session_start`. (On pi 1.x the extension API object has no `modelRegistry`. A `pi.modelRegistry`, if present, MAY be used only when no session registry has been captured.) When no registry is available at all, resolution SHALL fail with an actionable error. The fallback SHALL handle the two literal forms (`provider/model[:thinking]` and bare `model-id[:thinking]`) but SHALL NOT attempt `@role` lookup.

The fallback SHALL parse the `:thinking` suffix before any registry lookup, then:

- If the literal contains `/`, split into provider + id and call `registry.find(provider, id)`.
- Otherwise treat as a bare id and call `registry.getAll().find(m => m.id === literal)`.

On success, the fallback SHALL pass the resolved Model and thinking level to the agent session. On failure (no match for a literal, OR an `@role` reference), the agent invocation SHALL fail with `isError: true` and a structured error.

#### Scenario: Fallback resolves literal provider/model without a handler

- **GIVEN** an agent definition `model: "anthropic/claude-opus-4"` AND NO `model:resolve` handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the emit SHALL be silent (no listener)
- **AND** the flow engine SHALL call the session registry's `find("anthropic", "claude-opus-4")`
- **AND** the resulting Model SHALL be used to instantiate the agent session

#### Scenario: Fallback resolves bare model id without a handler

- **GIVEN** an agent definition `model: "claude-haiku-4-5"` AND NO handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** the flow engine SHALL call the session registry's `getAll().find(m => m.id === "claude-haiku-4-5")`
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

#### Scenario: Fallback works on pi 1.x where the extension API has no modelRegistry

- **GIVEN** the extension API object has no `modelRegistry` property AND `session_start` provided `ctx.modelRegistry` containing `prov/m1` AND NO `model:resolve` handler is registered
- **WHEN** a flow agent with `model: "prov/m1"` is resolved
- **THEN** resolution SHALL succeed using the session registry
- **AND** the error "Model registry unavailable" SHALL NOT occur


## ADDED Requirements

### Requirement: pi-flows SHALL accept the `max` thinking level

The set of thinking levels pi-flows recognises SHALL be `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`. This set SHALL apply both to the `:thinking`
suffix parsed by the in-process fallback and to an agent's `thinking:` frontmatter
field. A suffix not in this set SHALL NOT be stripped, and SHALL remain part of the
model id.

#### Scenario: `:max` suffix is parsed in the fallback

- **GIVEN** an agent definition `model: "anthropic/claude-opus-4:max"` AND NO
  `model:resolve` handler is registered
- **WHEN** the flow engine resolves the model
- **THEN** it SHALL call `pi.modelRegistry.find("anthropic", "claude-opus-4")`
- **AND** the agent session SHALL receive thinking level `max`.

#### Scenario: `thinking: max` frontmatter is passed through

- **GIVEN** an agent with `thinking: max`
- **WHEN** the agent session is created
- **THEN** the session SHALL receive thinking level `max`, overriding any model suffix.
