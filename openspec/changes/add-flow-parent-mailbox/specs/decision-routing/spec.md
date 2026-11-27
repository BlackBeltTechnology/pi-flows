# Spec Delta

## MODIFIED Requirements

### Requirement: Routing is a branch-label capability shared by decision nodes

`agent-decision` and `code-decision` nodes SHALL route by resolving one branch **label**, or with `multi: true` zero or more labels, against a `branches:` map of `label → target stepId`. The label source distinguishes the node type: an agent supplies it (`agent-decision`, via `finish(branch=)` or `finish(branches=)`), code supplies it (`code-decision`, via the reserved `branch` output or the `branches` / `routes` return), and for a `fork` the parent session's model, the fork's decider, the fork's `ask_default` on timeout, or — in a detached run without autonomous mode — the first option supplies it. The label → target resolution SHALL be identical across these node types; failure severity follows each node type's own rules.

#### Scenario: Agent decision routes by returned label
- **WHEN** an `agent-decision` agent calls `finish(branch="ready")` and `branches.ready` maps to `deploy`
- **THEN** the flow routes to step `deploy`

#### Scenario: Code decision routes by returned label
- **WHEN** a `code-decision` handler returns `{ branch: "auto_approve" }` and `branches.auto_approve` maps to `export`
- **THEN** the flow routes to step `export`

#### Scenario: Multi decision routes to several labels
- **WHEN** a `multi: true` agent-decision agent calls `finish(branches=["a", "b"])`
- **THEN** the steps reachable from the targets of `a` and `b` run AND the other steps of that segment are skipped

#### Scenario: Fork routes by the parent's label
- **WHEN** a fork in a parent-attached run asks and the parent replies `"skip"`, and `branches.skip` maps to `report`
- **THEN** the flow routes to step `report`
