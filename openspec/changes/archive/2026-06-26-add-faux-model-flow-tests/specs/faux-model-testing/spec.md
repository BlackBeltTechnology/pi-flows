## ADDED Requirements

### Requirement: Faux test harness

The test suite SHALL provide a reusable harness (`__tests__/faux-harness.ts`) that constructs a `pi-ai` faux provider, a `modelRegistry` stub backed by the faux models, and a `spawnAgent` invocation wired to that registry — without any network access or real credentials.

#### Scenario: Harness builds a runnable faux registry

- **WHEN** a test calls the harness to build a faux registry
- **THEN** the returned registry exposes `find` and `getAll` resolving to the faux model(s) and an `authStorage` whose resolver returns an empty auth object

#### Scenario: Harness drives the real spawnAgent loop

- **WHEN** a test invokes the harness spawn helper with an agent config and a scripted finish response
- **THEN** `spawnAgent` runs the real `createAgentSession` loop using the faux model resolved via `resolvedModelId`, and returns an `AgentResult`

### Requirement: Scripted-response model

The harness SHALL let a test queue deterministic provider responses — fixed assistant messages (text, thinking, or tool-call blocks) and turn-dependent factory functions — that the faux provider returns one per stream call.

#### Scenario: Fixed finish response

- **WHEN** a test queues a schema-valid `finish` tool call as the only response
- **THEN** the agent loop dispatches it, the finish latch captures it, and the result reports success with the finish output

#### Scenario: Turn-dependent factory response

- **WHEN** a test queues a factory that branches on call count or model id
- **THEN** each stream call receives the response the factory produces for that turn

### Requirement: Agent-loop capability coverage

The faux suites SHALL exercise, through the real session loop, the agent-loop behaviors not covered by existing seam tests.

#### Scenario: Finish happy path

- **WHEN** the agent's only response is a schema-valid `finish`
- **THEN** the result status is success and the finish summary/files/artifacts are wired into the `AgentResult`

#### Scenario: Finish retry and first-correct-wins latch

- **WHEN** the agent first returns a malformed/error finish and then a valid finish
- **THEN** the stop-gate retry runs within the `MAX_FINISH_RETRIES` bound and the first correct finish is latched as the result

#### Scenario: Authorized tool dispatch through guard

- **WHEN** the agent calls a tool present in `agent.tools` and then finishes
- **THEN** the guard permits the tool call, it is recorded in `toolCalls`, and the run completes

#### Scenario: Unauthorized tool blocked by guard

- **WHEN** the agent calls a tool not present in `agent.tools`
- **THEN** the guard blocks the call and the agent does not execute the unauthorized tool

#### Scenario: Abort mid-stream

- **WHEN** a response streams slowly and the spawn `AbortSignal` is aborted before completion
- **THEN** the run resolves with an aborted outcome rather than a successful finish

#### Scenario: Soft failure on agent-reported error finish

- **WHEN** the agent calls `finish` with `status: "error"`
- **THEN** the run resolves to a `node-failure-model` **soft** outcome (`source: "agent_finish_error"`)

#### Scenario: Hard failure on exhausted provider error

- **WHEN** every agent turn carries `stopReason: "error"` and the stop-gate retries are exhausted with no finish
- **THEN** the run resolves to a `node-failure-model` **hard** outcome (`source: "api_error"`)

### Requirement: Multi-agent discriminator and flow coverage

The `runFlow` faux smoke tests SHALL distinguish concurrent agents via a scripted-response selector (faux model id or the dispatched task text), not by hard-coding queue order, and SHALL exercise at least multi-step output wiring and parallel fan-in scheduling.

#### Scenario: Per-agent response selection

- **WHEN** a flow runs multiple agents
- **THEN** the faux provider returns each agent's scripted response selected by a stable discriminator (model id or task content), not by fragile queue ordering

#### Scenario: Multi-step output wiring

- **WHEN** a two-step flow wires `${{result.<step>.<out>}}` from a finished upstream step (declared agent output) into a downstream step blocked by it
- **THEN** the downstream agent receives the resolved upstream output value

#### Scenario: Parallel fan-in scheduling

- **WHEN** two independent steps run concurrently and a third step is `blockedBy` both
- **THEN** all three steps complete and the fan-in step runs only after both upstream steps finish

### Requirement: Tool-name prefix path coverage

The faux suites SHALL cover both tool-name forms: the default unprefixed `finish` (faux `api: "faux"`) and the `mcp__flows__`-prefixed name produced when `model.api === "anthropic-messages"`.

#### Scenario: Anthropic-messages prefix variant

- **WHEN** a faux model is configured with `api: "anthropic-messages"` and the agent finishes
- **THEN** the prefixed `mcp__flows__finish` tool name is used and the finish is captured correctly

### Requirement: Full-integration flow coverage

The harness SHALL provide a `runFauxFlow` helper that materializes `code` / `code-decision` handlers to temp files (wiring each step's `target:`), answers `fork` prompts, and surfaces step lifecycle callbacks — so a single large DAG can exercise agents, code nodes, decisions, and loops against one scripted faux model. At least one integration test SHALL drive a large flow combining parallel fan-in, input wiring, code-node typed outputs, code-decision routing, and an agent-decision loop.

Loop assertions SHALL use robust invariants (re-entry occurred, termination within `max_iterations`, exit branch reached) rather than exact iteration counts, because the `${{loop.<id>.iteration}}` counter timing is an engine-internal detail.

#### Scenario: Kitchen-sink pass path

- **WHEN** a large flow runs intake → parallel research fan-in → a `code` merge node → a `code-decision` gate routing `pass` → `build` → an `agent-decision` verify loop → `finalize`
- **THEN** fan-in inputs resolve, the code node's typed outputs wire downstream, the pass branch runs while the fail sibling is `skipped`, the loop re-enters the build step and terminates within `max_iterations`, and the forward exit branch completes

#### Scenario: Code-decision fail-branch exclusivity

- **WHEN** a `code-decision` handler returns a sub-threshold `branch`
- **THEN** the flow routes to that branch's target and the untaken sibling branch receives a `skipped` result

#### Scenario: Code handler materialization

- **WHEN** a flow step of type `code` or `code-decision` is given handler source via `runFauxFlow`'s `codeHandlers`
- **THEN** the source is written to a temp file, wired into the step's `target:`, executed by the real code-node executor, and its returned outputs become the step's typed results
