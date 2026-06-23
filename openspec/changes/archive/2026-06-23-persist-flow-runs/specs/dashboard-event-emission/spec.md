## ADDED Requirements

### Requirement: Per-agent error lifecycle event is emitted via `flow:agent-error`

When an agent step fails with a message-level error (as opposed to a tool result with `isError: true`), pi-flows SHALL emit `flow:agent-error` with `{ agentName, stepId, text }`, where `text` is the human-readable error. This gives the dashboard's existing `{ kind: "error" }` timeline entry a producer: today `FlowDetailEntry` defines an error kind but no flow event emits it, so message-level agent errors only flip `flow_agent_complete.status` and never appear as a discrete timeline entry.

The event SHALL be raised through a `FlowObserver` error hook (e.g. `onError`) so that both the live forward and the durable `flow-event` recording (see the `flow-session-persistence` capability) capture it.

#### Scenario: Agent message-level error emits a timeline event

- **WHEN** an agent step fails with a message-level error during a flow run
- **THEN** pi-flows SHALL emit `flow:agent-error` with `{ agentName, stepId, text }`
- **AND** the agent's terminal `flow:agent-complete` SHALL still carry `status: "error"` (the status flip is retained, not replaced)

#### Scenario: Error event is persisted and replayable

- **WHEN** `flow:agent-error` is emitted
- **THEN** it SHALL be recorded as a `flow-event` entry with `eventType: "flow_agent_error"` per the `flow-session-persistence` contract
- **AND** re-forwarding that record SHALL allow a consumer to append a `{ kind: "error", text }` entry to the agent's `detailHistory`

#### Scenario: Tool errors remain distinct from agent errors

- **WHEN** a tool returns a result with `isError: true`
- **THEN** that error SHALL continue to be conveyed via `flow:subagent-tool-result` (patching the paired tool timeline entry's `isError`), NOT via `flow:agent-error`
- **AND** `flow:agent-error` SHALL be reserved for message-level / step-level agent failures
