# Spec Delta

## MODIFIED Requirements

### Requirement: `flow:run` is the single programmatic entry point for starting a flow

Every host-driven producer that starts a flow (REST dispatch, domain-package tools, dashboard automations) SHALL funnel through the `flow:run` event. The engine SHALL handle `flow:run` through one code path with a single set of pre-start checks. There SHALL NOT be a duplicate guard that short-circuits before the shared pre-start checks. The engine's own `flow_run` tool SHALL call that same code path directly, and the code path SHALL report its outcome to the caller: the started run's `runId`, or the decline reason, byte-identical to the reason on the terminal rejection `flow:complete`, which SHALL still be emitted. Slash commands keep their own start path and notification behaviour.

#### Scenario: All producers share one dispatch path

- **WHEN** any host raises `flow:run` with a flow name
- **THEN** the engine SHALL evaluate the same pre-start checks (flow exists, no run active, gate satisfied, typed inputs valid) before starting
- **AND** no earlier guard SHALL cause a `flow:run` to return before those checks run

#### Scenario: flow_run uses the same path

- **WHEN** `flow_run` is called while a run is active
- **THEN** it SHALL return the same reason text the rejection `flow:complete` carries, and that `flow:complete` SHALL be emitted

## ADDED Requirements

### Requirement: Typed inputs are checked before a dispatched run starts
The shared dispatch path SHALL validate provided inputs against the flow's input schema before starting; a missing required input or a type mismatch SHALL decline the dispatch with the diagnostic as its reason, and no `flow:flow-started` SHALL be emitted.

#### Scenario: Missing required input via flow:run
- **WHEN** `flow:run` is raised for a flow with a required input that is not provided
- **THEN** a terminal rejection `flow:complete` SHALL carry the input diagnostic and no run SHALL start

### Requirement: `flow:run` accepts parent attachment
`flow:run` SHALL accept an optional `notifyParent` boolean. `notifyParent: true` SHALL make the run parent-attached; without it the run SHALL be detached. The field SHALL pass through the same single dispatch path and pre-start checks.

#### Scenario: Attached dispatch
- **WHEN** `flow:run` is raised with `notifyParent: true` and the run starts
- **THEN** the run SHALL be parent-attached

#### Scenario: Default is detached
- **WHEN** `flow:run` is raised without `notifyParent`
- **THEN** the run SHALL be detached
