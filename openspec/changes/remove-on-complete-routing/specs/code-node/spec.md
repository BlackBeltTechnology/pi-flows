## MODIFIED Requirements

### Requirement: Code node validation
The system SHALL validate code nodes in `flow_write`: `outputs` is optional; output names MUST be unique and valid JavaScript identifiers; input names MUST be valid JavaScript identifiers; the node `id` MUST be filesystem-safe; and `blockedBy`/`on_error` MUST reference existing step ids. A code node MUST NOT declare `on_complete` (removed); declaring it is a validation error.

#### Scenario: Duplicate output names rejected
- **WHEN** a code node declares two outputs with the same name
- **THEN** `flow_write` returns a validation error and does not persist

#### Scenario: Side-effect-only node is valid
- **WHEN** a code node declares no `outputs`
- **THEN** validation passes and the handler is expected to return `{}`

#### Scenario: Code node declaring on_complete is rejected
- **WHEN** a code node declares `on_complete: X`
- **THEN** `flow_write` returns a validation error naming the removed field and does not persist
