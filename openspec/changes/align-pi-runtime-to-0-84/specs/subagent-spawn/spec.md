## ADDED Requirements

### Requirement: spawnAgent supplies a complete ResourceLoader to createAgentSession

When `spawnAgent` constructs a subagent session, the `ResourceLoader` it passes to
`createAgentSession` SHALL implement the full loader interface required by the
current pi SDK, including the system-prompt-source accessors
`getSystemPromptSource()` and `getAppendSystemPromptSources()`.

Because `spawnAgent` composes the agent's system prompt in memory (no on-disk
prompt file backs it), these accessors SHALL report the absence of a source:
`getSystemPromptSource()` SHALL return `undefined`, and
`getAppendSystemPromptSources()` SHALL return an empty array. The existing
prompt-composition behaviour is preserved: `getSystemPrompt()` returns `undefined`
so the SDK builds its default system prompt, and `getAppendSystemPrompt()` returns
the agent-specific prompt to append.

#### Scenario: ResourceLoader implements the system-prompt-source accessors

- **WHEN** `spawnAgent` builds the `ResourceLoader` for a subagent session
- **THEN** the loader SHALL expose `getSystemPromptSource()` returning `undefined`
- **AND** the loader SHALL expose `getAppendSystemPromptSources()` returning `[]`
- **AND** `createAgentSession` SHALL construct the session without throwing on a
  missing loader method.

#### Scenario: Append-prompt composition is unchanged

- **WHEN** `spawnAgent` has composed an agent-specific system prompt
- **THEN** `getAppendSystemPrompt()` SHALL return that prompt as a single-element array
- **AND** `getSystemPrompt()` SHALL return `undefined` so the SDK still emits its
  default system prompt with tool descriptions.

### Requirement: spawnAgent supplies model/auth via the modelRuntime option

`spawnAgent` SHALL provide session model/auth to `createAgentSession` through the
SDK's `modelRuntime` option. It SHALL NOT pass the removed `authStorage` or
`modelRegistry` session-bootstrap options, and SHALL NOT import the removed
`AuthStorage` type from the pi SDK.

When a `modelRuntime` is available to the run it SHALL be forwarded; when none is
provided the option SHALL be omitted so the SDK builds its default runtime. The
model-role resolution path (which reads `pi.modelRegistry`) is unaffected by this
requirement.

#### Scenario: Bootstrap uses modelRuntime, not the removed options

- **WHEN** `spawnAgent` calls `createAgentSession`
- **THEN** the options object SHALL NOT contain an `authStorage` key
- **AND** the options object SHALL NOT contain a `modelRegistry` key
- **AND** model/auth SHALL be supplied via `modelRuntime` when one is available.

#### Scenario: Faux spawn constructs and completes under the current runtime

- **WHEN** a faux, zero-network agent is spawned via the real `spawnAgent` loop and
  scripted to finish successfully
- **THEN** the session SHALL be constructed without error
- **AND** the resulting agent outcome SHALL report success (not a session-creation
  error).
