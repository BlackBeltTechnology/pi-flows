## MODIFIED Requirements

### Requirement: Authoring tools are consolidated into `flow_agents` and `flow_write`

pi-flows SHALL expose exactly two authoring tools on the main session: `flow_agents` and `flow_write`. The former `agent_catalog`, `agent_write`, and the raw-path form of `flow_write` SHALL NOT be exposed as separate main-session tools. Both tools SHALL derive their write locations from the discovery convention and SHALL NOT accept a raw filesystem `path` parameter.

#### Scenario: `flow_agents` lists and writes agents

- **WHEN** `flow_agents` is called with `op: "list"`
- **THEN** it SHALL return the agent catalog (the data formerly returned by `agent_catalog`)
- **WHEN** `flow_agents` is called with `op: "write"` and a valid agent definition
- **THEN** it SHALL validate the content via `agent-validate.ts`
- **AND** on success SHALL write to the discovered location `.pi/flows/agents/<name>.md`
- **AND** SHALL NOT accept a raw `path` argument

#### Scenario: `flow_write` writes to a namespace-derived location

- **WHEN** `flow_write` is called with `namespace`, `name`, and `content`
- **THEN** it SHALL validate the content via `flow-validate.ts`
- **AND** on success SHALL write to `.pi/flows/flows/<namespace>/<name>/flow.yaml` (creating the flow directory)
- **AND** the written flow SHALL auto-register as the `/<namespace>:<name>` command
- **AND** when `namespace` is omitted it SHALL default to `custom`
- **AND** writing to an existing `<namespace>/<name>/flow.yaml` SHALL overwrite it (edit), with no separate edit tool

#### Scenario: Validation failure does not write

- **WHEN** `flow_write` or `flow_agents` (op `write`) is called with content that fails validation
- **THEN** no file SHALL be written
- **AND** the tool SHALL return the validation diagnostics so the caller can self-correct
