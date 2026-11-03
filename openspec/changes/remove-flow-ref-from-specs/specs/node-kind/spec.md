## MODIFIED Requirements

### Requirement: NodeKind taxonomy is defined and emitted by every node executor

pi-flows SHALL define a single `NodeKind` discriminator with the values `agent`, `fork`, `agent-decision`, `code`, and `code-decision`. Every node executor SHALL emit its `NodeKind` on the node's lifecycle started and complete callbacks (`onAgentStarted` / `onAgentComplete`), for ALL node types — not only `code` / `code-decision`. The `NodeKind` SHALL be named distinctly from the dashboard timeline-entry `kind` (`text | thinking | tool | error`) so the two do not collide.

#### Scenario: Agent node emits its kind
- **WHEN** an `agent` step starts and completes
- **THEN** its lifecycle started and complete callbacks SHALL carry `nodeKind: "agent"`

#### Scenario: Fork, decision, and flow-ref nodes emit their kind
- **WHEN** a `fork` or `agent-decision` node runs
- **THEN** its lifecycle callbacks SHALL carry `nodeKind` equal to `"fork"` or `"agent-decision"` respectively

#### Scenario: Code nodes emit their kind
- **WHEN** a `code` or `code-decision` node runs
- **THEN** its lifecycle callbacks SHALL carry `nodeKind` equal to `"code"` or `"code-decision"` respectively
