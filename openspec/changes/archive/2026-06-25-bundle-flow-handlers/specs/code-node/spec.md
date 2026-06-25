## MODIFIED Requirements

### Requirement: Handler location convention with target override

By default the system SHALL locate a code node's handler relative to the flow's own directory (the directory containing its `flow.yaml`, i.e. `dirname(flow.source)`): real file `<flowDir>/<id>.ts` and reference template `<flowDir>/<id>.ts.default`. The system SHALL NOT reconstruct the handler path from `cwd` plus the flow name. A node MAY set `target:` to override the real-file path for shared or custom-path handlers (`target:` is resolved against `cwd`, unchanged).

#### Scenario: Convention-based location
- **WHEN** the flow at `.pi/flows/flows/research/main/flow.yaml` has a code node `validate-nav` with no `target:`
- **THEN** the engine runs `.pi/flows/flows/research/main/validate-nav.ts`

#### Scenario: Explicit target override
- **WHEN** a code node sets `target: ./shared/nav.ts`
- **THEN** the engine runs that file instead of the convention path
