## ADDED Requirements

### Requirement: `code-decision` step type

The system SHALL provide a `code-decision` step that executes a TypeScript handler exactly like a `code` node (same handler location convention, input wiring, execution context, in-process execution, soft timeout, and soft/hard failure model) and additionally routes on a reserved `branch` output. The handler SHALL be invoked via the same `executeCodeStep` execution path as `code`.

#### Scenario: Executes like a code node
- **WHEN** a `code-decision` step runs with declared `inputs` and a handler at the conventional path
- **THEN** inputs are template-expanded and passed to the handler identically to a `code` node

#### Scenario: Missing handler fails the same way
- **WHEN** a `code-decision` handler file is absent
- **THEN** the step produces the same soft failure with a copy-the-template hint as a `code` node

### Requirement: Reserved `branch` output drives routing

A `code-decision` handler SHALL return an object containing a reserved key `branch` whose string value names the chosen branch. The engine SHALL resolve `branch` against the step's `branches:` map and route to the mapped step. The reserved `branch` value SHALL NOT be required to appear in the step's declared data `outputs`.

#### Scenario: Branch selects target
- **WHEN** a handler returns `{ branch: "needs_human" }` and `branches.needs_human` maps to `human-approval`
- **THEN** the flow routes to `human-approval`

#### Scenario: Missing branch is malformed
- **WHEN** a `code-decision` handler returns an object with no `branch` key
- **THEN** the step SHALL fail naming the missing reserved `branch` output

### Requirement: Branch plus data outputs

A `code-decision` handler MAY return declared data outputs alongside `branch` (e.g. `{ branch, approvers }`). Declared data outputs SHALL be validated and coerced exactly as for a `code` node and made available downstream via `${{result.<id>.<name>}}`. A `code-decision` node SHALL NOT declare a data output named `branch`.

#### Scenario: Data output wired downstream
- **WHEN** a handler returns `{ branch: "auto_approve", approvers: "alice,bob" }` with `approvers` declared
- **THEN** `${{result.<id>.approvers}}` resolves to `alice,bob` in subsequent steps

#### Scenario: Declaring `branch` as data output is rejected
- **WHEN** a `code-decision` declares an output named `branch`
- **THEN** validation SHALL report an error (the name is reserved for routing)

### Requirement: Off-map branch is a hard failure

When a `code-decision` handler returns a `branch` value not present in the `branches:` map, the engine SHALL treat it as a hard failure that halts the flow, independent of any `on_error` routing (consistent with `agent-decision`).

#### Scenario: Unknown branch halts
- **WHEN** a handler returns `{ branch: "maybe" }` and `branches` has only `yes`/`no`
- **THEN** the flow halts with a hard failure naming the invalid branch and the valid set

### Requirement: Type-safe branch scaffold generation

The handler scaffold generator (`/flows:generate`) SHALL emit, for each `code-decision` step, a `Branch` union type built from the `branches:` keys and SHALL type the handler return as `Promise<{ branch: Branch } & <declared outputs>>`. As with `code` nodes, scaffolds are written with a `.default` suffix and never overwrite an implemented handler.

#### Scenario: Union reflects branches
- **WHEN** a `code-decision` declares `branches: { auto_approve, needs_human, park }`
- **THEN** the generated scaffold contains `type Branch = "auto_approve" | "needs_human" | "park"`

#### Scenario: Wrong branch is a compile-time error
- **WHEN** an implemented handler returns `{ branch: "approve" }` not in the union
- **THEN** TypeScript reports a type error at the return site
