## ADDED Requirements

### Requirement: Flow is a self-contained directory

A flow SHALL be defined by a `flow.yaml` inside a per-flow directory at `.pi/flows/flows/<namespace>/<name>/flow.yaml`. The flow's code handlers SHALL live in that same directory. `FlowConfig.source` SHALL be the absolute path to that `flow.yaml`.

#### Scenario: Flow definition location

- **WHEN** a flow `capabilities` is authored under namespace `test`
- **THEN** its definition SHALL be `.pi/flows/flows/test/capabilities/flow.yaml`
- **AND** `FlowConfig.source` for that flow SHALL point at that `flow.yaml`

#### Scenario: Command id derived from the directory structure

- **WHEN** discovery loads `.pi/flows/flows/test/capabilities/flow.yaml`
- **THEN** the flow SHALL register as the `/test:capabilities` command (namespace + name from the directory path, slashes joined by `:`)

### Requirement: Handlers resolve relative to the flow directory

The engine SHALL resolve a convention-based code/code-decision handler relative to the flow's own directory: `join(dirname(flow.source), "<id>.ts")` (reference template `join(dirname(flow.source), "<id>.ts.default")`). The engine SHALL NOT reconstruct the handler path from `cwd` plus the flow name. When `flow.source` is empty and a convention handler is required, the engine SHALL fail loudly with a clear message (a `target:` remains the escape hatch).

#### Scenario: Convention handler is read from the flow directory

- **WHEN** the flow at `.pi/flows/flows/test/capabilities/flow.yaml` runs a code node `transform` with no `target:`
- **THEN** the engine SHALL run `.pi/flows/flows/test/capabilities/transform.ts`

#### Scenario: Generator scaffolds into the same directory

- **WHEN** templates are generated for that flow's `transform` node
- **THEN** the `transform.ts.default` SHALL be written to `.pi/flows/flows/test/capabilities/transform.ts.default`
- **AND** the generated and runtime paths SHALL be identical (same directory as `flow.yaml`)

### Requirement: Deleting a flow removes its directory

Deleting a flow SHALL remove the flow's directory, so its co-located handlers are removed with it and cannot be orphaned.

#### Scenario: Delete removes handlers too

- **WHEN** the `/test:capabilities` flow is deleted
- **THEN** `.pi/flows/flows/test/capabilities/` SHALL be removed, including `flow.yaml` and every `<id>.ts` / `<id>.ts.default`

### Requirement: Clean break — the flat layout is not supported

Discovery SHALL read ONLY the bundled form (`<namespace>/<name>/flow.yaml`). It SHALL NOT read the previous flat `.pi/flows/flows/<namespace>/<name>.yaml` form, and the engine SHALL NOT read the previous parallel `.pi/flows/handlers/<flow>/` tree. There SHALL be no fallback to the old layout.

#### Scenario: Old flat flow is not discovered

- **WHEN** a flow exists only as `.pi/flows/flows/custom/legacy.yaml` (flat, no enclosing `legacy/` directory)
- **THEN** discovery SHALL NOT register it as a command

#### Scenario: Old handlers tree is not consulted

- **WHEN** a code node's handler exists only under the old `.pi/flows/handlers/<flow>/<id>.ts`
- **THEN** the engine SHALL treat the handler as missing (it resolves only the flow-directory path)
