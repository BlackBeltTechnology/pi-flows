## ADDED Requirements

### Requirement: `model:` accepts a single ref, an ordered list, or nothing

An agent's `model:` SHALL accept a single ref (`@name`, `provider/model[:thinking]`, or a bare `model-id[:thinking]`), an ordered list of such refs, or be omitted. A single ref SHALL behave exactly like a one-entry list. For a list, the first entry that resolves SHALL be used.

#### Scenario: Legacy single role ref resolves as before

- **GIVEN** a `model:resolve` handler that resolves `@coding` to `prov/coder`
- **WHEN** a flow step runs an agent with `model: @coding`
- **THEN** the agent session SHALL be created with `prov/coder`

#### Scenario: List uses the first resolvable entry

- **GIVEN** no `model:resolve` handler AND a session registry containing `anthropic/claude-haiku-4-5`
- **WHEN** a flow step runs an agent with `model: [@fast, anthropic/claude-haiku-4-5]`
- **THEN** `@fast` SHALL be skipped and the agent session SHALL be created with `anthropic/claude-haiku-4-5`

#### Scenario: Literal entry that does not exist is an error

- **GIVEN** a session registry without `anthropic/claude-haku`
- **WHEN** a flow step runs an agent with `model: [anthropic/claude-haku, @fast]`
- **THEN** the step SHALL fail with an error naming `anthropic/claude-haku`
- **AND** the remaining entries SHALL NOT be tried

### Requirement: Unresolvable `@`-refs fall back to the session model unless strict

An `@`-ref is unresolvable when no `model:resolve` handler answers or the handler reports an error. When every entry of `model:` is an unresolvable `@`-ref, or `model:` is omitted, the agent SHALL run on the dispatching session's model as it was when the flow started, using the agent's `thinking:` when set and the session's thinking level otherwise. When setting `flows.modelFallback` is `"error"`, the step SHALL fail instead. The default SHALL be `"session"`.

#### Scenario: No resolver installed

- **GIVEN** no `model:resolve` handler AND a parent session running `prov/parent`
- **WHEN** a flow step runs an agent with `model: @fast`
- **THEN** the agent session SHALL be created with `prov/parent`
- **AND** the step SHALL NOT fail

#### Scenario: Resolver reports the role as not assigned

- **GIVEN** a `model:resolve` handler that sets `probe.error` for `@fast` AND a parent session running `prov/parent`
- **WHEN** a flow step runs an agent with `model: @fast`
- **THEN** the agent session SHALL be created with `prov/parent`

#### Scenario: Agent without model

- **GIVEN** a parent session running `prov/parent` at flow start
- **WHEN** a flow step runs an agent whose frontmatter has no `model:`
- **THEN** the agent session SHALL be created with `prov/parent`

#### Scenario: Strict mode fails instead of falling back

- **GIVEN** setting `flows.modelFallback: "error"` AND no `model:resolve` handler
- **WHEN** a flow step runs an agent with `model: @fast`
- **THEN** the step SHALL fail with an error naming `@fast` and stating that no entry resolved

#### Scenario: No session model available

- **GIVEN** a flow started without any captured session model
- **WHEN** an agent's entries are all unresolvable `@`-refs
- **THEN** the step SHALL fail with an error naming the agent and the missing session model

### Requirement: A model fallback is reported

When an agent runs on a fallback instead of its first `model:` entry, pi-flows SHALL report it: the agent-started event SHALL carry the requested ref(s), the model used, and the reason (`no-resolver`, `resolver-error`, or `no-model-declared`), and the agent card SHALL show the model actually used.

#### Scenario: Fallback appears on the agent-started event

- **GIVEN** no `model:resolve` handler AND a parent session running `prov/parent`
- **WHEN** an agent with `model: @fast` starts
- **THEN** the `flow:agent-started` payload SHALL include `@fast`, `prov/parent`, and reason `no-resolver`

### Requirement: Agent validation SHALL treat model refs as opaque

Agent validation SHALL NOT contain or check against any list of model role names. It SHALL only check syntax: each ref is non-empty and any `:thinking` suffix names a valid thinking level. A missing `model:` SHALL NOT be an error.

#### Scenario: Any @-ref passes validation without warnings

- **WHEN** an agent with `model: @my-custom-alias` is validated
- **THEN** validation SHALL report no diagnostic for the model ref

#### Scenario: List and omitted model validate

- **WHEN** agents with `model: [@fast, anthropic/claude-haiku-4-5]` and with no `model:` are validated
- **THEN** validation SHALL report no error for either

#### Scenario: Invalid thinking suffix is reported

- **WHEN** an agent with `model: anthropic/claude-haiku-4-5:extreme` is validated
- **THEN** validation SHALL report a diagnostic naming the invalid level and listing the valid levels

### Requirement: Write-time model resolution SHALL be advisory

When `flow_agents` writes an agent, pi-flows SHALL emit `model:resolve` for each declared `@`-ref. A resolver error SHALL NOT block the write; the result SHALL include a warning carrying the resolver's message and the fallback that will apply at runtime. A silent emit SHALL add no diagnostic.

#### Scenario: Resolver rejects the ref

- **GIVEN** a `model:resolve` handler that sets `probe.error = "Role \"@nope\" is not assigned"`
- **WHEN** `flow_agents` writes an agent with `model: @nope`
- **THEN** the file SHALL be written
- **AND** the result SHALL contain a warning that includes `Role "@nope" is not assigned`

#### Scenario: No resolver installed

- **GIVEN** no `model:resolve` handler
- **WHEN** `flow_agents` writes an agent with `model: @anything`
- **THEN** the file SHALL be written with no model-related diagnostic

### Requirement: Flow execution SHALL use the resolved Model object directly

When resolution yields a `Model` object, flow execution SHALL create the agent session from that object and SHALL NOT look the model id up again in the registry. When a step's model is resolved before spawning, the resolved `Model` SHALL be passed through to the spawn.

#### Scenario: Resolver-supplied Model is used without a second lookup

- **GIVEN** a `model:resolve` handler that resolves `@fast` to a Model whose id is NOT in the session registry
- **WHEN** a flow step runs an agent with `model: @fast`
- **THEN** the agent session SHALL be created with the handler's Model
- **AND** the step SHALL NOT fail with `Failed to resolve model`

#### Scenario: Pre-resolved step carries the Model to spawn

- **GIVEN** a flow agent step whose model is resolved before spawning
- **WHEN** the agent is spawned
- **THEN** the session registry's `find` SHALL NOT be called for that agent's model

## MODIFIED Requirements

### Requirement: pi-flows SHALL resolve `model:` references via the shared `model:resolve` event

When the flow engine encounters a `model:` field in an agent definition or flow YAML, it SHALL emit `pi.events.emit("model:resolve", probe)` exactly once per ref it tries, with a probe object of shape:

```
{ ref: string, resolved?: string, model?: Model, thinkingLevel?: ThinkingLevelString, auth?: object, error?: string, available?: { roles?, models? } }
```

After the emit returns, the flow engine SHALL read `probe.model`, `probe.thinkingLevel`, and `probe.error` synchronously. The handler is responsible for handling all three input forms (`@role`, `provider/model[:thinking]`, bare `model-id`) transparently. The flow engine itself SHALL NOT attempt to interpret `@role` prefixes beyond treating an unanswered or rejected `@`-ref as unresolvable, SHALL NOT parse provider/model separators before the emit, and SHALL NOT read `providers.json` — that is the handler's responsibility.

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

- **GIVEN** an agent definition `model: "@unknownrole"` AND a handler is registered that sets `probe.error`
- **WHEN** the flow engine resolves the model
- **THEN** `@unknownrole` SHALL be treated as unresolvable and the fallback rules SHALL apply
- **AND** when the step ultimately fails (strict mode or no session model), the error SHALL include the handler-supplied message and the agent definition's source

#### Scenario: Handler error on a literal ref fails the step

- **GIVEN** an agent definition `model: "vendor/made-up"` AND a handler that sets `probe.error` for it
- **WHEN** the flow engine resolves the model
- **THEN** the agent invocation SHALL fail with a clear error that includes the handler-supplied message and the agent definition's source

### Requirement: pi-flows SHALL fall back to in-process `pi.modelRegistry` resolution when no `model:resolve` handler answers

When the `model:resolve` emit returns with both `probe.model` and `probe.error` unset (silent emit — no handler reacted), the flow engine SHALL attempt in-process resolution using the **session's model registry**: the `ctx.modelRegistry` captured from the most recent `session_start`. (On pi 1.x the extension API object has no `modelRegistry`. A `pi.modelRegistry`, if present, MAY be used only when no session registry has been captured.) When no registry is available at all, resolution of a literal ref SHALL fail with an actionable error. The fallback SHALL handle the two literal forms (`provider/model[:thinking]` and bare `model-id[:thinking]`); it SHALL NOT attempt `@role` lookup — an `@`-ref with a silent emit is unresolvable and the session-model fallback rules apply.

The fallback SHALL parse the `:thinking` suffix before any registry lookup, then:

- If the literal contains `/`, split into provider + id and call `registry.find(provider, id)`.
- Otherwise treat as a bare id and call `registry.getAll().find(m => m.id === literal)`.

On success, the fallback SHALL pass the resolved Model and thinking level to the agent session. On failure for a literal, the agent invocation SHALL fail with `isError: true` and a structured error.

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
- **AND** with `flows.modelFallback` unset the agent SHALL run on the session model per the session-model fallback requirement (no error)
- **AND** only with `flows.modelFallback: "error"` SHALL the invocation fail, with a message stating that `@`-refs need a `model:resolve` resolver (e.g. pi-agent-dashboard)

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

### Requirement: The edit-flow skill SHALL teach all three `model:` reference forms

The authoring skill (`skills/manage-flows/SKILL.md`) SHALL document `model:` so the main session can author agents: a single literal ref (`provider/model[:thinking]` or bare `model-id`), an optional `@name` ref resolved by an installed `model:resolve` resolver (e.g. pi-agent-dashboard roles) that falls back to the session model when unresolvable, an ordered list, and omitting `model:` (session model). It SHALL include one example of each and SHALL NOT list role names or present `@role` as the preferred form.

#### Scenario: All three forms are documented in the skill

- **WHEN** a developer reads `skills/manage-flows/SKILL.md`
- **THEN** the content SHALL describe: a single literal ref, a single `@name` ref, a list, and omitted `model:`
- **AND** the section SHALL include one example of each form
- **AND** the section SHALL state that `@name` needs a resolver and otherwise falls back per `flows.modelFallback`
- **AND** the section SHALL NOT contain a list of role names

#### Scenario: Authored agent definitions can use any form

- **GIVEN** the user has asked for "an agent that always uses anthropic/claude-haiku-4-5:high"
- **WHEN** the main session authors the agent's frontmatter via `flow_agents`
- **THEN** the generated `model:` field MAY contain the literal `anthropic/claude-haiku-4-5:high`
- **AND** the resulting file SHALL resolve correctly at runtime via the resolveModel implementation
