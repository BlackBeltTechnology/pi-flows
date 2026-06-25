# Node Kind

## Purpose

Defines the single `NodeKind` discriminator that every node executor emits on its lifecycle started/complete callbacks, and how consumers (dashboard, TUI observers) use it to select a card renderer for both live and replayed runs. `NodeKind` is named distinctly from the dashboard timeline-entry `kind` so the two cannot collide; it is decided once at the node's started event and carried on the payload, making renderer selection identical live or on replay.

## Requirements

### Requirement: NodeKind taxonomy is defined and emitted by every node executor

pi-flows SHALL define a single `NodeKind` discriminator with the values `agent`, `fork`, `agent-decision`, `code`, `code-decision`, and `flow-ref`. Every node executor SHALL emit its `NodeKind` on the node's lifecycle started and complete callbacks (`onAgentStarted` / `onAgentComplete`), for ALL node types — not only `code` / `code-decision`. The `NodeKind` SHALL be named distinctly from the dashboard timeline-entry `kind` (`text | thinking | tool | error`) so the two do not collide.

#### Scenario: Agent node emits its kind
- **WHEN** an `agent` step starts and completes
- **THEN** its lifecycle started and complete callbacks SHALL carry `nodeKind: "agent"`

#### Scenario: Fork, decision, and flow-ref nodes emit their kind
- **WHEN** a `fork`, `agent-decision`, or `flow-ref` node runs
- **THEN** its lifecycle callbacks SHALL carry `nodeKind` equal to `"fork"`, `"agent-decision"`, or `"flow-ref"` respectively

#### Scenario: Code nodes emit their kind
- **WHEN** a `code` or `code-decision` node runs
- **THEN** its lifecycle callbacks SHALL carry `nodeKind` equal to `"code"` or `"code-decision"` respectively

### Requirement: Card renderer is selected by nodeKind for live and replayed runs

A consumer (dashboard or TUI observer) SHALL select the card renderer for a node from its `nodeKind`. The selection SHALL behave identically whether the events arrive live or are re-forwarded from persisted records, because `nodeKind` is decided once at the node's started event and carried on the payload.

#### Scenario: Code node renders a code card
- **WHEN** a node's started event carries `nodeKind: "code"`
- **THEN** the consumer SHALL render it as a code card rather than an agent card

#### Scenario: Unknown kind degrades to a generic card
- **WHEN** a consumer has no card registered for a given `nodeKind`
- **THEN** the node SHALL still render as a generic node card (the `nodeKind` tag is additive, not required for baseline rendering)

### Requirement: Code-node text entries are program logs by virtue of the card's kind

A `code` / `code-decision` node's `logger()` output SHALL continue to travel on the existing assistant-text channel; no new event type and no per-line marker SHALL be required. Because a node's card type is fixed at its started event, the assistant-text entries attached to a `code` / `code-decision` card SHALL be interpreted as program logs by virtue of the card's `nodeKind`.

#### Scenario: Code logger output renders as program logs
- **WHEN** a `code` node calls `logger(msg)` and the card was created with `nodeKind: "code"`
- **THEN** `msg` SHALL render as a program-log entry under that code card

#### Scenario: Agent assistant text is not treated as a program log
- **WHEN** an `agent` node emits assistant text under a card with `nodeKind: "agent"`
- **THEN** the text SHALL render as agent assistant output, not as a program log

### Requirement: Code nodes surface their resolved handler target

A `code` / `code-decision` node's started event SHALL include the resolved handler `target` path, so a live or replayed code card can show which handler ran. Capturing the full handler source body SHALL be out of scope for this capability.

#### Scenario: Code node started event includes the resolved target
- **WHEN** a `code` node with a resolved handler at `flows/handlers/foo.ts` starts
- **THEN** its started event payload SHALL include that resolved `target` path

#### Scenario: Full source body is not captured
- **WHEN** a `code` node starts
- **THEN** the started event SHALL NOT embed the full handler source body
