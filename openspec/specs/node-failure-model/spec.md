# node-failure-model Specification

## Purpose
TBD - created by archiving change node-failure-model. Update Purpose after archive.
## Requirements
### Requirement: Node failure outcomes
Every node execution SHALL resolve to exactly one outcome: `success`, `soft` failure, or `hard` failure. On `success` the node performs no routing — control falls through to the next step in file order. A `soft` failure is recoverable and routes to the node's `on_error`. A `hard` failure is unrecoverable and stops the entire flow.

#### Scenario: Success falls through to the next step
- **WHEN** a node completes successfully
- **THEN** control proceeds to the next step in file order (no success-routing edge)

#### Scenario: Outcome is one of three
- **WHEN** any node finishes executing
- **THEN** the engine classifies it as exactly one of `success`, `soft`, or `hard`

### Requirement: on_error is the soft switch
A soft-eligible failure SHALL route to `on_error` when the node declares one (SOFT outcome). A soft-eligible failure on a node with **no** `on_error` SHALL hard-fail the flow.

#### Scenario: Soft-eligible failure with on_error routes there
- **WHEN** a node soft-fails and declares `on_error: park`
- **THEN** the flow routes to `park` and continues

#### Scenario: Soft-eligible failure without on_error hard-fails
- **WHEN** a node soft-fails and declares no `on_error`
- **THEN** the flow hard-fails (stops)

### Requirement: Hard failure halts the flow
A hard failure SHALL abort in-flight parallel steps (as with user abort, but with final flow status `error`), skip all pending steps, end the flow with status `error`, and surface the failure message. The hard-fail reason SHALL be recorded in the flow result for the main session to read.

#### Scenario: Hard fail aborts siblings and stops
- **WHEN** a node hard-fails while sibling steps are running in parallel
- **THEN** the in-flight siblings are signalled to stop, all pending steps are skipped, and the flow ends with status `error`

#### Scenario: Hard-fail reason recorded
- **WHEN** a hard failure ends a flow
- **THEN** the flow result carries status `error` and the failure message

### Requirement: Agents do not deliberately hard-fail; failures are classified structurally
The system SHALL classify agent failures by how the agent terminated, without parsing error-message text and without any deliberate hard signal from the agent:
- `finish(status:"complete")` → success.
- `finish(status:"error")` or `finish(status:"blocked")` → SOFT (the agent ran and reported a logical failure).
- terminated with an API error (`stopReason:"error"`, i.e. pi's auto-retries exhausted: rate limit, quota, auth) and no finish → HARD (the provider is unusable for the rest of the flow).
- terminated without finishing and without an API error → SOFT.

#### Scenario: Agent reports logical error
- **WHEN** an agent calls `finish(status:"error")`
- **THEN** the node is a SOFT failure (routes `on_error`, or hard-fails if unset)

#### Scenario: Agent infrastructure error stops the flow
- **WHEN** an agent terminates with an API error after pi exhausted its retries and never called finish
- **THEN** the node is a HARD failure and the flow stops

#### Scenario: Agent stalls without an API error
- **WHEN** an agent stops without calling finish and there is no API error
- **THEN** the node is a SOFT failure

### Requirement: Capped no-finish reminder
When an agent stops without calling `finish` and there is no API error, the system SHALL issue at most **two** reminders that include the `finish` tool-call format. If the agent still has not called `finish` after the reminders, the node SHALL resolve as a clean SOFT failure (not `status:"unknown"`, not an unbounded loop).

#### Scenario: Reminder then soft failure
- **WHEN** an agent stops without finishing
- **THEN** it receives up to two reminders showing the `finish` format, and if it still does not finish the node is a SOFT failure

#### Scenario: Agent finishes after a reminder
- **WHEN** an agent stops without finishing, receives a reminder, and then calls `finish(status:"complete")`
- **THEN** the node succeeds

### Requirement: Transient retry delegated to pi
The system SHALL rely on pi-coding-agent's built-in auto-retry for transient agent errors (rate limit, 5xx, overloaded, network, timeout) and SHALL NOT add a redundant retry layer. Errors that reach the flow engine from an agent are treated as terminal.

#### Scenario: No redundant retry
- **WHEN** an agent error reaches the flow engine
- **THEN** the engine does not retry it and treats it as a terminal outcome to be classified soft or hard

### Requirement: FlowHardError for code and extension nodes
The package SHALL export a `FlowHardError` class. For code and extension nodes, a plain `throw` (or any error that is not a `FlowHardError`) SHALL be a SOFT failure, and `throw new FlowHardError(msg)` SHALL be an unconditional HARD failure that stops the flow regardless of `on_error`.

#### Scenario: Plain throw is soft
- **WHEN** a code handler executes `throw new Error("nope")`
- **THEN** the node is a SOFT failure (routes `on_error`, or hard-fails if unset)

#### Scenario: FlowHardError is hard
- **WHEN** a code handler executes `throw new FlowHardError("fatal")` with `on_error` set
- **THEN** the flow hard-fails (stops), ignoring `on_error`

