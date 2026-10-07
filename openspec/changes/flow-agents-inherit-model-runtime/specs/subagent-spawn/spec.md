## MODIFIED Requirements

### Requirement: spawnAgent supplies model/auth via the modelRuntime option

`spawnAgent` SHALL provide session model/auth to `createAgentSession` through the
SDK's `modelRuntime` option. It SHALL NOT pass the removed `authStorage` or
`modelRegistry` session-bootstrap options, and SHALL NOT import the removed
`AuthStorage` type from the pi SDK.

When a flow runs inside a pi session, the runtime supplied to every agent session
it spawns (agent steps, autonomous fork-decision agents, and `agent-decision`
agents including loop iterations) SHALL be the parent session's own model runtime: the same
providers and API keys, including providers registered at runtime via
`pi.registerProvider()`. When no parent runtime is available (programmatic run
without a session), the option SHALL be omitted so the SDK builds its default
runtime.

Only providers and credentials are shared. The agent's model SHALL NOT be inherited
from the parent session: it SHALL come solely from the agent's own `model:`
reference via model resolution, and an agent whose model is missing or cannot be
resolved SHALL still fail. The model-role resolution path (which reads
`pi.modelRegistry`) is unaffected by this requirement.

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

#### Scenario: Runtime-registered provider is usable by a flow agent

- **GIVEN** a parent session whose real model registry has a provider registered at
  runtime via `registerProvider` (with an API key) that does not exist in
  `models.json` or `auth.json`
- **WHEN** a flow agent whose `model:` names a model of that provider is spawned
- **THEN** the agent session SHALL resolve that provider and its API key from the
  parent runtime
- **AND** the first request SHALL NOT fail with "No API key found" or "Unknown
  provider".

#### Scenario: Provider registered after session start is visible

- **GIVEN** a provider is registered on the parent runtime after the session started
- **WHEN** a flow agent using that provider's model is spawned
- **THEN** the agent session SHALL resolve that provider and its API key.

#### Scenario: A new session replaces the captured runtime

- **WHEN** a new parent session starts in the same process
- **THEN** subsequently spawned flow agents SHALL use the new session's runtime and SHALL NOT use the previous one.

#### Scenario: Every agent-spawning step kind receives the same runtime

- **WHEN** a flow spawns agents via an agent step, an autonomous fork decision, and an
  `agent-decision` step that loops back at least once
- **THEN** every one of those agent sessions SHALL receive the same parent model runtime.

#### Scenario: Model is never inherited from the parent

- **GIVEN** the parent session's current model is `X`
- **WHEN** an agent with no resolvable `model:` (missing or unknown ref) is spawned
- **THEN** the agent invocation SHALL fail with a model-resolution error
- **AND** it SHALL NOT fall back to model `X`.

#### Scenario: No parent runtime falls back to the default runtime

- **WHEN** a flow is run programmatically without a parent session runtime
- **THEN** `createAgentSession` SHALL be called without a `modelRuntime` key.
