## ADDED Requirements

### Requirement: Flow opt-in via `auto_end` key
A flow SHALL declare whether it may end its parent session by setting a top-level `auto_end` boolean in `flow.yaml`. When `auto_end` is absent or `false`, the flow MUST NOT trigger any session shutdown. The parser SHALL expose the value on the flow's configuration.

#### Scenario: Flow declares auto_end true
- **WHEN** a `flow.yaml` contains top-level `auto_end: true`
- **THEN** the parsed flow configuration exposes `auto_end === true`

#### Scenario: Flow omits auto_end
- **WHEN** a `flow.yaml` has no `auto_end` key
- **THEN** the parsed flow configuration exposes `auto_end` as `false` or undefined
- **AND** completion of that flow never triggers a session shutdown

### Requirement: Non-interactive gate
The system SHALL honor auto-end only in a non-interactive (headless) session, determined from the `hasUI` signal captured at session start. In an interactive session the parent session MUST NOT be shut down, regardless of the flow's `auto_end` value.

#### Scenario: Interactive session is never closed
- **WHEN** a flow with `auto_end: true` completes successfully
- **AND** the session is interactive (`hasUI` is true)
- **THEN** the parent session remains open

#### Scenario: Non-interactive session is eligible
- **WHEN** a flow with `auto_end: true` completes successfully
- **AND** the session is non-interactive (`hasUI` is false)
- **THEN** the parent session is gracefully shut down

### Requirement: Combined gate
The system SHALL end the parent session only when the completed flow's `auto_end` is `true` AND the session is non-interactive AND the terminal status passes the status filter. If any condition fails, the session MUST NOT be shut down.

#### Scenario: All conditions satisfied
- **WHEN** a flow with `auto_end: true` completes with `status: "success"` in a non-interactive session
- **THEN** the parent session is gracefully shut down

#### Scenario: Flow does not opt in
- **WHEN** a flow without `auto_end` completes successfully in a non-interactive session
- **THEN** the parent session remains open

### Requirement: Flow result reports success status
On successful completion the flow result SHALL carry `status: "success"`, and on user cancellation it SHALL carry `status: "aborted"`. This is the precondition the terminal-status gate depends on; success MUST NOT be represented only by the absence of a status.

#### Scenario: Successful flow sets status success
- **WHEN** a flow completes with all steps succeeding
- **THEN** the returned flow result has `status: "success"`

#### Scenario: Cancelled flow sets status aborted
- **WHEN** a flow is cancelled by the user
- **THEN** the returned flow result has `status: "aborted"`

### Requirement: Terminal-status filter (success only)
When the flow and non-interactive conditions are satisfied, the system SHALL trigger shutdown only for a flow whose terminal `status` is `success`. A `status` of `aborted` MUST NOT trigger shutdown. A `status` of `error` MUST NOT trigger shutdown by default.

#### Scenario: Successful completion triggers shutdown
- **WHEN** the flow and non-interactive conditions are satisfied and a flow completes with `status: "success"`
- **THEN** the parent session is gracefully shut down

#### Scenario: Aborted flow never triggers shutdown
- **WHEN** both opt-ins are satisfied and a flow ends with `status: "aborted"`
- **THEN** the parent session remains open

#### Scenario: Errored flow does not trigger shutdown by default
- **WHEN** both opt-ins are satisfied and a flow ends with `status: "error"`
- **THEN** the parent session remains open

### Requirement: Graceful shutdown via existing action
When the gate passes, the system SHALL end the session by invoking the existing graceful `shutdown()` action rather than forcibly terminating the process. Shutdown MUST occur only after the flow has reached its terminal state (i.e. in response to `flow:complete`).

#### Scenario: Shutdown uses graceful action
- **WHEN** the auto-end gate passes for a completed flow
- **THEN** the system calls the graceful `shutdown()` action
- **AND** does not call it before `flow:complete` for that run has fired
