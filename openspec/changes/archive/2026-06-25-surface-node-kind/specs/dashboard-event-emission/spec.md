## MODIFIED Requirements

### Requirement: Code-decision node lifecycle events carry a distinguishing kind

The `pi-flows` engine SHALL tag `code-decision` lifecycle events with `nodeKind: "code-decision"` as one value of the unified `NodeKind` discriminator (see the `node-kind` capability), so the dashboard can render a distinct decision card. The `nodeKind` SHALL actually reach observers — it SHALL NOT be dropped at the `FlowManager` callback fan-out. The chosen branch SHALL be observable from the completion event (e.g. via the step's typed outputs / routing result), enabling the dashboard to display which branch was taken without re-deriving it.

#### Scenario: Started and complete carry kind
- **WHEN** a `code-decision` step begins and finishes
- **THEN** pi-flows SHALL emit its lifecycle started and complete events with `nodeKind: "code-decision"`, observable by a registered observer

#### Scenario: Chosen branch is observable
- **WHEN** a `code-decision` resolves to branch `auto_approve`
- **THEN** the completion event payload SHALL allow the dashboard to determine the taken branch was `auto_approve`

#### Scenario: Dashboard degrades gracefully without a dedicated card
- **WHEN** a dashboard build has no `code-decision` card registered
- **THEN** the events SHALL still be consumable as a generic node card (the `nodeKind` tag is additive, not required for baseline rendering)

## ADDED Requirements

### Requirement: Lifecycle events carry nodeKind through the FlowManager fan-out

The `FlowManager` observer fan-out SHALL forward the lifecycle `extra` argument (carrying `nodeKind`) to every registered observer rather than discarding it, and the `FlowObserver` `onAgentStarted` / `onAgentComplete` signatures SHALL accept it. The `flow:agent-started` and `flow:agent-complete` event payloads emitted by `EventEmitObserver` SHALL include `nodeKind` for ALL node types.

#### Scenario: Agent node nodeKind reaches observers
- **WHEN** an `agent` node starts and the engine invokes the FlowManager lifecycle callback with `nodeKind: "agent"`
- **THEN** every registered observer's `onAgentStarted` SHALL receive `nodeKind: "agent"` and the emitted `flow:agent-started` payload SHALL include it

#### Scenario: nodeKind is no longer dropped
- **WHEN** any node emits a lifecycle event with a `nodeKind`
- **THEN** the value SHALL appear on the corresponding `flow:agent-started` / `flow:agent-complete` payload and SHALL NOT be silently dropped at the FlowManager boundary
