## MODIFIED Requirements

### Requirement: Canonical step-type set

The flow engine SHALL recognize exactly these step types: `agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`. Every step SHALL declare its type explicitly via a `type:` field; the parser SHALL NOT infer a step's type from which other fields are present. The parser SHALL reject a step that omits `type:` with an error naming the step id and listing the valid types. The parser SHALL reject any unknown `type:` value with an error naming the unknown type and the step id.

#### Scenario: Known type parses
- **WHEN** a step declares `type: code-decision`
- **THEN** the parser produces a step of that type without error

#### Scenario: Missing type rejected
- **WHEN** a step declares `agent: researcher` but no `type:` field
- **THEN** the parser SHALL throw an error naming the step id and listing the valid step types

#### Scenario: Unknown type rejected
- **WHEN** a step declares `type: switch`
- **THEN** the parser SHALL throw an error naming `switch` and the step id

#### Scenario: Removed type surfaces a migration error
- **WHEN** a step declares `type: conditional` or `type: agent-loop-decision`
- **THEN** the parser SHALL throw the corresponding migration error directing the author to `code-decision` / `agent-decision`
