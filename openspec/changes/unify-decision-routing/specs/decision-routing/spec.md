## ADDED Requirements

### Requirement: Canonical step-type set

The flow engine SHALL recognize exactly these step types: `agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`. The parser SHALL reject any other `type:` value with an error naming the unknown type and the step id.

#### Scenario: Known type parses
- **WHEN** a step declares `type: code-decision`
- **THEN** the parser produces a step of that type without error

#### Scenario: Unknown type rejected
- **WHEN** a step declares `type: switch`
- **THEN** the parser SHALL throw an error naming `switch` and the step id

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
- **THEN** validation SHALL report an error advising use of a plain `code` node with `on_complete`

## REMOVED Requirements

### Requirement: `agent-loop-decision` step type
**Reason**: A loop is a `*-decision` whose branch points backward; the dedicated type duplicated routing logic for a purely topological difference.
**Migration**: Replace `type: agent-loop-decision` with `type: agent-decision`. Move `loop_target` and `exit_target` into `branches:` (e.g. `branches: { rework: <loop_target>, done: <exit_target> }`) and keep `max_iterations`. The decision agent calls `finish(branch="rework")` or `finish(branch="done")`.

### Requirement: `conditional` step type
**Reason**: `conditional` is a degenerate `code-decision` (emptiness-only, 2-way); maintaining it duplicates routing for a case the general node covers in a few lines.
**Migration**: Replace `type: conditional` with `type: code-decision`. Implement a handler that reads the checked input and returns `{ branch: "present" }` or `{ branch: "absent" }`, with `branches: { present: <present-target>, absent: <absent-target> }`.
