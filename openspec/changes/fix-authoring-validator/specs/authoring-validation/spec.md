# Spec Delta

## Purpose

Makes flow and agent validation match what the engine actually does: reject definitions that would silently misbehave, accept valid ones, and never drop fields without saying so.

## ADDED Requirements

### Requirement: Agent outputs may not shadow finish fields

Agent validation SHALL report an error for a declared output named `status`, `summary`, `files` or `artifacts`, and for an output named `branch` on an agent used as a decision agent. The message SHALL name the field and suggest a different name.

#### Scenario: status output rejected
- **WHEN** an agent declares `outputs: [{ name: status }]`
- **THEN** validation SHALL report an error naming `status` as a reserved finish field

#### Scenario: Renamed output accepted
- **WHEN** an agent declares `outputs: [{ name: outcome }]`
- **THEN** validation SHALL NOT report a reserved-name error

### Requirement: Definitions are re-discovered for every flow run

At the start of every flow run pi-flows SHALL re-discover agents and flows, so edits to agent or flow files apply to that run without a session reload.

#### Scenario: Edited agent applies to the next run
- **GIVEN** a session that has already run a flow AND the user then renames an agent's output in its file
- **WHEN** the flow is started again
- **THEN** the run SHALL use the renamed output

### Requirement: Valid definitions are accepted

Validation SHALL accept `tools: []` (an agent with no tools) and `${{flow.input.<name>}}` references to inputs the flow declares.

#### Scenario: Empty tools list
- **WHEN** an agent declares `tools: []`
- **THEN** validation SHALL report no error for `tools`

#### Scenario: Flow input reference
- **GIVEN** a flow declaring `inputs: { ref: { type: string } }`
- **WHEN** a step uses `${{flow.input.ref}}`
- **THEN** validation SHALL accept it

### Requirement: Fields are never silently dropped

The parser and validator SHALL either honour or reject inline-list `inputs:`/`outputs:`, `on_error` on `fork` and `agent-decision`, and agent `card.type`; none of them SHALL be accepted and then ignored.

#### Scenario: on_error on a fork
- **WHEN** a `fork` step declares `on_error: report`
- **THEN** either the engine SHALL route a failed fork to `report`, or validation SHALL report an error; the field SHALL NOT be ignored silently

### Requirement: Fork branches match options

Validation SHALL report an error for a fork `branches` key that is not one of the fork's `options`, naming the key.

#### Scenario: Stray branch key
- **GIVEN** a fork with `options: [yes, no]`
- **WHEN** it declares `branches: { yes: a, maybe: b }`
- **THEN** validation SHALL report an error naming `maybe`

### Requirement: Structured agent outputs are not accepted until delivered

Agent validation SHALL report an error for an output declared `type: object` or `type: array`, stating that structured agent outputs are not supported and suggesting a JSON string output.

#### Scenario: Array output rejected
- **WHEN** an agent declares an output with `type: array`
- **THEN** validation SHALL report an error naming the output

### Requirement: flow_write paths are safe and documented

`flow_write` SHALL reject `name` or `namespace` values not matching `^[a-z0-9][a-z0-9-]*$` with a validation error and SHALL write nothing for them; its description SHALL state the path `.pi/flows/flows/<namespace>/<name>/flow.yaml`.

#### Scenario: Path traversal rejected
- **WHEN** `flow_write` is called with `name: "../../x"`
- **THEN** it SHALL return a validation error AND no file SHALL be written
