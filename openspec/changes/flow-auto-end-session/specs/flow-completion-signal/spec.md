## ADDED Requirements

### Requirement: Flow completion is signalled with outcome metadata
When a flow reaches a terminal state, the system SHALL append a completion message carrying the outcome (status + summary) and emit `flow:complete`, so a host/automation runner has everything needed to finalize the run and display success/failure. Emission SHALL be unconditional — every flow run, every terminal outcome — with no opt-in key and no mode/interactivity gate, and SHALL NOT shut down the session.

Note on `agent_end`: an automation runner finalizes runs on the core `agent_end` event. A pi extension cannot emit the core `agent_end` (it is a turn-lifecycle event, and `flow:run` is handled outside an agent turn); surfacing `agent_end` for an event-launched flow run is therefore a **host/dashboard responsibility** (e.g. mapping the forwarded `flow:complete` to its finalize path). This capability guarantees only that the outcome is available; it does not itself emit core `agent_end`.

#### Scenario: Flow run signals completion with outcome
- **WHEN** a flow reaches a terminal state
- **THEN** the system appends a completion message carrying `status` + summary and emits `flow:complete`

#### Scenario: No opt-in required
- **WHEN** any flow completes
- **THEN** the completion signal is emitted without the flow declaring any key and without a mode/interactivity check

### Requirement: Completion signal carries outcome metadata
The completion signal SHALL carry the flow's terminal outcome: `status` (`success` | `error` | `aborted`) and a human-readable summary of what happened, so the runner can display success/failure rather than only that the run ended. The metadata SHALL be sourced from the flow result (`FlowResult.status` and the last result summary).

#### Scenario: Success metadata
- **WHEN** a flow completes successfully
- **THEN** the completion signal reports `status: "success"` and a summary of the outcome

#### Scenario: Failure metadata
- **WHEN** a flow ends with `error` or `aborted`
- **THEN** the completion signal reports that `status` and a summary describing the failure

### Requirement: Completion signal does not shut down the session
Emitting the completion signal SHALL NOT terminate, close, or shut down the session or its process. The system MUST NOT call `ctx.shutdown()` for flow completion. Session/keeper teardown is the responsibility of the host/automation layer, out of scope here.

#### Scenario: Session stays alive after the signal
- **WHEN** the completion signal is emitted
- **THEN** the session/process remains running and is not shut down by the flow engine

### Requirement: Completion message replaces the persistence completion marker
The end-of-flow completion message SHALL be the single message appended at flow end, opening pi's `hasAssistant` flush gate so buffered flow events persist for `/resume`. The former dedicated completion marker (the `[flow] <name> finished` message emitted solely for persistence) SHALL be removed — the completion message serves both persistence and the runner-finalize signal. The completion message MUST remain a non-empty assistant text block with a well-formed zero `usage`. The start marker (emitted at flow start for mid-run reload survival) is unaffected.

#### Scenario: One message at flow end opens the flush gate
- **WHEN** a flow completes
- **THEN** exactly one completion message is appended, and it opens the persistence flush gate (no separate `finished` marker is emitted)

#### Scenario: Start marker retained
- **WHEN** a flow starts
- **THEN** the start marker is still emitted to open the flush gate up front

### Requirement: Flow result reports terminal status
On successful completion the flow result SHALL carry `status: "success"`, and on user cancellation `status: "aborted"`; success MUST NOT be represented only by the absence of a status. This status is the source of the completion signal's outcome metadata.

#### Scenario: Successful flow sets status success
- **WHEN** a flow completes with all steps succeeding
- **THEN** the returned flow result has `status: "success"`

#### Scenario: Cancelled flow sets status aborted
- **WHEN** a flow is cancelled by the user
- **THEN** the returned flow result has `status: "aborted"`
