## MODIFIED Requirements

### Requirement: Reserved `branch` output drives routing

A `code-decision` handler SHALL return an object containing a reserved key `branch` whose string value names the chosen branch, or, on a `multi: true` step, exactly one of `branch`, `branches` or `routes`. The engine SHALL resolve the label(s) against the step's `branches:` map and route to the mapped step(s). Reserved routing keys SHALL NOT be required to appear in the step's declared data `outputs`.

#### Scenario: Branch selects target
- **WHEN** a handler returns `{ branch: "needs_human" }` and `branches.needs_human` maps to `human-approval`
- **THEN** the flow routes to `human-approval`

#### Scenario: Missing branch is malformed
- **WHEN** a `code-decision` handler returns an object with no routing key
- **THEN** the step SHALL fail naming the missing reserved `branch` output (or, on a multi step, `branch`/`branches`/`routes`)

## ADDED Requirements

### Requirement: Multi code decisions return branches or routes

A `code-decision` handler of a `multi: true` step SHALL return exactly one of `{ branch }`, `{ branches: string[] }` or `{ routes: [{ branch, items? }] }`, plus data outputs. An off-map label SHALL be a hard failure; duplicate labels, a non-array `items`, no routing key or more than one routing key SHALL be a soft failure naming the step.

#### Scenario: Routes with items
- **WHEN** a multi handler returns `{ routes: [{ branch: "apply", items: [{ "change": "a" }, { "change": "b" }] }] }`
- **THEN** the `apply` target SHALL run twice with `${{item.change}}` `a` and `b`

#### Scenario: Off-map label among several
- **WHEN** a multi handler returns `{ branches: ["a", "nope"] }` and `nope` is not a branch
- **THEN** the step SHALL fail hard naming `nope` and listing the valid branches

#### Scenario: Two routing keys
- **WHEN** a multi handler returns `{ branch: "a", branches: ["b"] }`
- **THEN** the step SHALL soft-fail naming the step and saying exactly one of branch, branches, routes is allowed
