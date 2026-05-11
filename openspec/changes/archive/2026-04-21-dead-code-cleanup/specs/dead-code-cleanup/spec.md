## REMOVED Requirements

### Requirement: subagent tool registration
The system SHALL NOT register a `subagent` tool on the main session. Flow execution uses direct `spawnAgent()` calls; no tool-based dispatch path is needed.

**Reason**: The tool was never invoked — all flow execution paths call `spawnAgent()` directly. The tool returned wrong data (`result.output` instead of structured finish payload) and lacked observer wiring, cancellation support, and extension tool forwarding.
**Migration**: None required. No code path invoked this tool.

#### Scenario: subagent tool removed from main session
- **WHEN** the flow-engine extension activates
- **THEN** no tool named "subagent" SHALL be registered on the main session

### Requirement: flow:delete-result event emission
The system SHALL NOT emit `flow:delete-result` events from flow-context. The deletion handler returns results synchronously via the event-bus mutation pattern.

**Reason**: Emitted by 3 code paths but no listener existed anywhere in the monorepo.
**Migration**: None required. No consumer depended on this event.

#### Scenario: flow:delete-result no longer emitted
- **WHEN** a flow deletion is processed via `flow:delete-request`
- **THEN** the handler SHALL NOT emit `flow:delete-result`

### Requirement: flow:register-guard-extension deprecated alias
The system SHALL NOT listen for the `flow:register-guard-extension` event. The canonical event is `flow:register-agent-extension`.

**Reason**: Marked as deprecated in code comments. Zero emitters in the monorepo.
**Migration**: Any external emitter should use `flow:register-agent-extension` instead.

#### Scenario: deprecated alias removed
- **WHEN** an external package emits `flow:register-guard-extension`
- **THEN** the event SHALL NOT be handled (no listener exists)
