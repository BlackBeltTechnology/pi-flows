## MODIFIED Requirements

### Requirement: Flow validation covers branch routing

Flow validation SHALL report: (a) a branch target that does not name an existing step (unreachable branch), (b) a `branches:` entry whose label is declared but unroutable, (c) a backward-edge node missing `max_iterations`, and (d) a `*-decision` node with fewer than two branches.

#### Scenario: Dangling branch target
- **WHEN** a branch maps a label to a stepId that does not exist
- **THEN** validation SHALL report an unreachable-branch error naming the label and stepId

#### Scenario: Decision with a single branch
- **WHEN** a `code-decision` declares only one branch
- **THEN** validation SHALL report an error advising a plain `code` node ordered with `blockedBy` instead

## ADDED Requirements

### Requirement: `on_complete` is rejected
The `on_complete` step field has been removed. Flow validation SHALL report an error when any step declares `on_complete`, with an actionable message directing the author to order steps with `blockedBy` or select a forward path with a `fork`/`code-decision` node. Success routing no longer exists; a node that succeeds falls through to the next step in file order.

#### Scenario: Declaring on_complete is an error
- **WHEN** a step declares `on_complete: X`
- **THEN** flow validation SHALL report an error naming the removed field and the migration path (`blockedBy` / decision node)

#### Scenario: on_error is unaffected
- **WHEN** a step declares `on_error: X` and no `on_complete`
- **THEN** validation accepts the step and soft-failure routing to `X` is unchanged
