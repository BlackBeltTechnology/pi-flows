## MODIFIED Requirements

### Requirement: Routing is a branch-label capability shared by decision nodes

`agent-decision` and `code-decision` nodes SHALL route by resolving one branch **label**, or with `multi: true` zero or more labels, against a `branches:` map of `label → target stepId`. The label source distinguishes the node type: an agent supplies it (`agent-decision`, via `finish(branch=)` or `finish(branches=)`), code supplies it (`code-decision`, via the reserved `branch` output or the `branches` / `routes` return), and a human supplies it (`fork`). The label → target resolution SHALL be identical across these node types; failure severity follows each node type's own rules.

#### Scenario: Agent decision routes by returned label
- **WHEN** an `agent-decision` agent calls `finish(branch="ready")` and `branches.ready` maps to `deploy`
- **THEN** the flow routes to step `deploy`

#### Scenario: Code decision routes by returned label
- **WHEN** a `code-decision` handler returns `{ branch: "auto_approve" }` and `branches.auto_approve` maps to `export`
- **THEN** the flow routes to step `export`

#### Scenario: Multi decision routes to several labels
- **WHEN** a `multi: true` agent-decision agent calls `finish(branches=["a", "b"])`
- **THEN** the steps reachable from the targets of `a` and `b` run AND the other steps of that segment are skipped

### Requirement: Routing nodes always execute; skipped forward siblings are typed-empty

A routing node SHALL always execute before control leaves it, so its own outputs are always populated; for a loop, its outputs SHALL reflect the last iteration. Forward branches not taken, and every step a forward route jumps over (any step type), SHALL receive synthetic `skipped` results if they have none; for a `multi: true` decision, every step of the activated segment not reachable from a chosen target SHALL receive a synthetic `skipped` result, replacing any earlier result. Unresolved `${{result.<stepId>.<field>}}` references SHALL expand to the empty string, never `undefined`.

#### Scenario: Loop node output is last-iteration value
- **WHEN** a looping `code-decision` runs three iterations then exits
- **THEN** `${{result.<id>.<output>}}` resolves to the third iteration's value

#### Scenario: Skipped sibling yields typed-empty
- **WHEN** a decision routes to branch `B` and not `C`
- **THEN** `result.C.status` SHALL be `skipped` and `${{result.C.summary}}` SHALL expand to the empty string

#### Scenario: Jumped-over separator is skipped
- **WHEN** a decision routes `skip` to a step after code-decision `e2e`, jumping over it
- **THEN** `result.e2e.status` SHALL be `skipped`

#### Scenario: Unchosen branches of a multi decision are skipped
- **WHEN** a `multi: true` decision chooses `A` and `B` out of `A`, `B`, `C`
- **THEN** `result.C.status` SHALL be `skipped`

### Requirement: Flow validation covers branch routing

Flow validation SHALL report: (a) a branch target that does not name an existing step (unreachable branch), (b) a `branches:` entry whose label is declared but unroutable, (c) a backward-edge node missing `max_iterations`, and (d) a `*-decision` node with fewer than two branches, or with no branch when it sets `multi: true`.

#### Scenario: Dangling branch target
- **WHEN** a branch maps a label to a stepId that does not exist
- **THEN** validation SHALL report an unreachable-branch error naming the label and stepId

#### Scenario: Decision with a single branch
- **WHEN** a `code-decision` without `multi: true` declares only one branch
- **THEN** validation SHALL report an error advising a plain `code` node ordered with `blockedBy` instead

#### Scenario: Multi decision with a single branch
- **WHEN** a `code-decision` with `multi: true` declares exactly one branch
- **THEN** validation SHALL report no branch-count error

### Requirement: Loop is a backward branch edge

A `*-decision` branch target MAY point to a step that re-enters the node (a backward edge, i.e. a loop). When any branch of a node forms such a cycle, the node MUST declare `max_iterations`. The engine SHALL track per-node iteration counts in the existing loop counters and SHALL force exit when `max_iterations` is exceeded: a single decision falls through to the next step in file order, a `multi: true` decision acts as if it chose no branch. A node whose branches all point forward SHALL NOT require `max_iterations`.

#### Scenario: Backward edge loops until satisfied
- **WHEN** a `code-decision` returns `{ branch: "rework" }` whose target is an earlier step and `max_iterations` is 3
- **THEN** the engine re-enters the loop target and increments the node's iteration count

#### Scenario: Iteration cap forces exit
- **WHEN** a node with a backward branch reaches `max_iterations`
- **THEN** the engine SHALL stop looping and not re-enter the loop target again

#### Scenario: Multi decision at the cap
- **WHEN** a `multi: true` node at `max_iterations` returns its backward branch again
- **THEN** every step of the segment after it SHALL be `skipped` AND execution SHALL continue after that segment

#### Scenario: Backward edge without max_iterations is rejected
- **WHEN** a `*-decision` node has a branch target that forms a cycle but declares no `max_iterations`
- **THEN** flow validation SHALL report an error for that node
