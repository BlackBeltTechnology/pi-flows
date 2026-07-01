# decision-routing Specification

## Purpose
TBD - created by archiving change unify-decision-routing. Update Purpose after archive.
## Requirements
### Requirement: Canonical step-type set

The flow engine SHALL recognize exactly these step types: `agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`. Every step SHALL declare its type explicitly via a `type:` field; the parser SHALL NOT infer a step's type from which other fields are present. The parser SHALL reject a step that omits `type:` with an error naming the step id and listing the valid types. The parser SHALL reject any unknown `type:` value with an error naming the unknown type and the step id.

#### Scenario: Known type parses
- **WHEN** a step declares `type: code-decision`
- **THEN** the parser produces a step of that type without error

#### Scenario: Missing type rejected
- **WHEN** a step declares `agent: researcher` but no `type:` field
- **THEN** the parser SHALL throw an error naming the step id and listing the valid step types

#### Scenario: Unknown type rejected
- **WHEN** a step declares `type: switch`
- **THEN** the parser SHALL throw an error naming `switch` and the step id

#### Scenario: Removed type surfaces a migration error
- **WHEN** a step declares `type: conditional` or `type: agent-loop-decision`
- **THEN** the parser SHALL throw the corresponding migration error directing the author to `code-decision` / `agent-decision`

### Requirement: Routing is a branch-label capability shared by decision nodes

`agent-decision` and `code-decision` nodes SHALL route by resolving a branch **label** against a `branches:` map of `label → target stepId`. The label source distinguishes the node type: an agent supplies it (`agent-decision`, via `finish(branch=)`), code supplies it (`code-decision`, via the reserved `branch` output), and a human supplies it (`fork`). The routing resolution SHALL be identical across these node types.

#### Scenario: Agent decision routes by returned label
- **WHEN** an `agent-decision` agent calls `finish(branch="ready")` and `branches.ready` maps to `deploy`
- **THEN** the flow routes to step `deploy`

#### Scenario: Code decision routes by returned label
- **WHEN** a `code-decision` handler returns `{ branch: "auto_approve" }` and `branches.auto_approve` maps to `export`
- **THEN** the flow routes to step `export`

### Requirement: Loop is a backward branch edge

A `*-decision` branch target MAY point to a step that re-enters the node (a backward edge, i.e. a loop). When any branch of a node forms such a cycle, the node MUST declare `max_iterations`. The engine SHALL track per-node iteration counts in the existing loop counters and SHALL force exit when `max_iterations` is exceeded. A node whose branches all point forward SHALL NOT require `max_iterations`.

#### Scenario: Backward edge loops until satisfied
- **WHEN** a `code-decision` returns `{ branch: "rework" }` whose target is an earlier step and `max_iterations` is 3
- **THEN** the engine re-enters the loop target and increments the node's iteration count

#### Scenario: Iteration cap forces exit
- **WHEN** a node with a backward branch reaches `max_iterations`
- **THEN** the engine SHALL stop looping and not re-enter the loop target again

#### Scenario: Backward edge without max_iterations is rejected
- **WHEN** a `*-decision` node has a branch target that forms a cycle but declares no `max_iterations`
- **THEN** flow validation SHALL report an error for that node

### Requirement: Routing nodes always execute; skipped forward siblings are typed-empty

A routing node SHALL always execute before control leaves it, so its own outputs are always populated; for a loop, its outputs SHALL reflect the last iteration. Forward branches not taken SHALL receive synthetic `skipped` results. Unresolved `${{result.<stepId>.<field>}}` references SHALL expand to the empty string, never `undefined`.

#### Scenario: Loop node output is last-iteration value
- **WHEN** a looping `code-decision` runs three iterations then exits
- **THEN** `${{result.<id>.<output>}}` resolves to the third iteration's value

#### Scenario: Skipped sibling yields typed-empty
- **WHEN** a decision routes to branch `B` and not `C`
- **THEN** `result.C.status` SHALL be `skipped` and `${{result.C.summary}}` SHALL expand to the empty string

### Requirement: Flow validation covers branch routing

Flow validation SHALL report: (a) a branch target that does not name an existing step (unreachable branch), (b) a `branches:` entry whose label is declared but unroutable, (c) a backward-edge node missing `max_iterations`, and (d) a `*-decision` node with fewer than two branches.

#### Scenario: Dangling branch target
- **WHEN** a branch maps a label to a stepId that does not exist
- **THEN** validation SHALL report an unreachable-branch error naming the label and stepId

#### Scenario: Decision with a single branch
- **WHEN** a `code-decision` declares only one branch
- **THEN** validation SHALL report an error advising a plain `code` node ordered with `blockedBy` instead

### Requirement: `on_complete` is rejected
The `on_complete` step field has been removed. Flow validation SHALL report an error when any step declares `on_complete`, with an actionable message directing the author to order steps with `blockedBy` or select a forward path with a `fork`/`code-decision` node. Success routing no longer exists; a node that succeeds falls through to the next step in file order.

#### Scenario: Declaring on_complete is an error
- **WHEN** a step declares `on_complete: X`
- **THEN** flow validation SHALL report an error naming the removed field and the migration path (`blockedBy` / decision node)

#### Scenario: on_error is unaffected
- **WHEN** a step declares `on_error: X` and no `on_complete`
- **THEN** validation accepts the step and soft-failure routing to `X` is unchanged

