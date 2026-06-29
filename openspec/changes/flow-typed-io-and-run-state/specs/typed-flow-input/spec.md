## ADDED Requirements

### Requirement: Flow declares a typed input schema
A flow definition SHALL accept an optional `inputs:` schema declaring named
inputs, each with a type and an optional `required` flag. The schema is part of
the flow's parsed configuration.

#### Scenario: flow declares typed inputs
- **WHEN** a flow declares `inputs: { ref: { type: string, required: true }, count: { type: number } }`
- **THEN** the flow parses successfully and its configuration carries those input declarations

#### Scenario: invalid input declaration is rejected
- **WHEN** an `inputs:` entry omits a type or uses an unknown type
- **THEN** flow validation fails with a diagnostic naming the offending input

### Requirement: A run is started with a structured input object
The engine SHALL accept a structured `inputs` object at run start across every
invocation path (slash command, the `flow:run` event, and the programmatic run
API), alongside the existing `task` string. Provided inputs MUST be validated
against the flow's declared schema; a missing `required` input or a type
mismatch MUST fail the run start with a diagnostic.

#### Scenario: structured inputs provided at start
- **WHEN** a run is started with `inputs: { ref: "abc", count: 3 }` and the flow declares those inputs
- **THEN** the run begins and the values are available to steps as typed inputs

#### Scenario: missing required input fails start
- **WHEN** a run is started without a declared `required` input
- **THEN** the run does not start and the error names the missing input

### Requirement: Flow inputs are exposed to steps
Declared flow inputs SHALL be referenceable in templates as
`${{flow.input.<name>}}` and SHALL be conveyed to code-node handlers as typed
values (per the structured-step-data rules). A non-string flow input
interpolated into a template SHALL serialize at the text boundary.

#### Scenario: flow input in a task template
- **WHEN** a step task contains `${{flow.input.ref}}` and `ref` is `"abc"`
- **THEN** the expansion yields `abc`

#### Scenario: flow input typed into a code handler
- **WHEN** a code node consumes `${{flow.input.count}}` where `count` is the number `3`
- **THEN** the handler receives `3` as a number

### Requirement: Single-task invocation remains supported
A flow with no `inputs:` schema SHALL still be startable with only the `task`
string, and `${{task}}` SHALL continue to resolve as before. The structured
input object is additive and optional.

#### Scenario: legacy task-only start
- **WHEN** a flow without an `inputs:` schema is started with a task string only
- **THEN** the run starts and `${{task}}` resolves to that string
