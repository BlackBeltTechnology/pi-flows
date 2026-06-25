## ADDED Requirements

### Requirement: Code-decision node lifecycle events carry a distinguishing kind

The `pi-flows` engine SHALL emit the same agent/code lifecycle events for `code-decision` steps and SHALL tag them with `kind: "code-decision"` so the dashboard can render a distinct decision card. The chosen branch SHALL be observable from the completion event (e.g. via the step's typed outputs / routing result), enabling the dashboard to display which branch was taken without re-deriving it.

#### Scenario: Started and complete carry kind
- **WHEN** a `code-decision` step begins and finishes
- **THEN** pi-flows SHALL emit its lifecycle started and complete events with `kind: "code-decision"`

#### Scenario: Chosen branch is observable
- **WHEN** a `code-decision` resolves to branch `auto_approve`
- **THEN** the completion event payload SHALL allow the dashboard to determine the taken branch was `auto_approve`

#### Scenario: Dashboard degrades gracefully without a dedicated card
- **WHEN** a dashboard build has no `code-decision` card registered
- **THEN** the events SHALL still be consumable as a generic node card (the `kind` tag is additive, not required for baseline rendering)

### Requirement: Backward-edge decision nodes emit loop-iteration events

When a `code-decision` or `agent-decision` routes along a backward edge (re-enters an ancestor), the engine SHALL emit the existing `flow:loop-iteration` event for that node with `{ stepId, iteration, maxIterations, loopTarget }`, reusing the established loop-counter bookkeeping. Loop status SHALL be conveyed exclusively by this runtime event, NOT inferred from the presence of `max_iterations` (a static capability that does not imply the node looped on a given run).

#### Scenario: Backward edge fires loop-iteration
- **WHEN** a `code-decision` returns a branch whose target is an ancestor step
- **THEN** the engine SHALL emit `flow:loop-iteration` with the node's `stepId`, incremented `iteration`, configured `maxIterations`, and the `loopTarget`

#### Scenario: Existing loop badge lights up
- **WHEN** a backward-edge `code-decision` is on iteration 2 of 3
- **THEN** the running node card SHALL display the existing iteration badge (e.g. ↻ 2/3) driven by the loop-iteration event

#### Scenario: Capable-but-not-looping node shows no loop badge
- **WHEN** a `code-decision` declares `max_iterations` but exits on its first pass without taking a backward edge
- **THEN** no `flow:loop-iteration` event SHALL be emitted and no loop badge SHALL be shown

### Requirement: Static flow preview detects backward edges from branches

The static flow preview (pre-run diagram) SHALL determine loop arrows by detecting backward edges in the `branches:` topology of `*-decision` nodes (a branch target that is an ancestor of the node), annotated with the node's `max_iterations`. It SHALL NOT rely on a dedicated loop step type, since `agent-loop-decision` is removed.

#### Scenario: Backward branch rendered as loop arrow
- **WHEN** a `*-decision` node has a branch whose target is an ancestor
- **THEN** the preview SHALL draw a loop arrow to that target annotated with `(max N iterations)`

#### Scenario: All-forward decision renders no loop arrow
- **WHEN** a `*-decision` node's branch targets are all descendants
- **THEN** the preview SHALL render it as a plain decision with no loop arrow
