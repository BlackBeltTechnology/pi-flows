## MODIFIED Requirements

### Requirement: Node failure outcomes
Every node execution SHALL resolve to exactly one outcome: `success`, `soft` failure, or `hard` failure. On `success` the node performs no routing — control falls through to the next step in file order. A `soft` failure is recoverable and routes to the node's `on_error`. A `hard` failure is unrecoverable and stops the entire flow.

#### Scenario: Success falls through to the next step
- **WHEN** a node completes successfully
- **THEN** control proceeds to the next step in file order (no success-routing edge)

#### Scenario: Outcome is one of three
- **WHEN** any node finishes executing
- **THEN** the engine classifies it as exactly one of `success`, `soft`, or `hard`
