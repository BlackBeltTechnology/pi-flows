## MODIFIED Requirements

### Requirement: Routing is a branch-label capability shared by decision nodes

`agent-decision` and `code-decision` nodes SHALL route by resolving a branch **label** against a `branches:` map of `label → target stepId`. The label source distinguishes the node type: an agent or a classifier supplies it (`agent-decision` and autonomous `fork`, via the decider chain), code supplies it (`code-decision`, via the reserved `branch` output), and a human supplies it (interactive `fork`). A branch value SHALL be either a target stepId string or an object `{ to: <stepId>, means: <string> }`; both forms SHALL route identically, and `means` SHALL only serve as the branch's description. The routing resolution SHALL be identical across these node types.

#### Scenario: Agent decision routes by returned label
- **WHEN** an `agent-decision` agent calls `finish(branch="ready")` and `branches.ready` maps to `deploy`
- **THEN** the flow routes to step `deploy`

#### Scenario: Code decision routes by returned label
- **WHEN** a `code-decision` handler returns `{ branch: "auto_approve" }` and `branches.auto_approve` maps to `export`
- **THEN** the flow routes to step `export`

#### Scenario: Object branch form routes like the string form
- **WHEN** a decision returns label `done` and `branches.done` is `{ to: report, means: "No blocking issues" }`
- **THEN** the flow routes to step `report`

#### Scenario: Classifier label routes like an agent label
- **WHEN** a trusted classifier answer for an `agent-decision` step returns label `fix` and `branches.fix` maps to `fixer`
- **THEN** the flow routes to step `fixer` exactly as if an agent had returned `fix`
