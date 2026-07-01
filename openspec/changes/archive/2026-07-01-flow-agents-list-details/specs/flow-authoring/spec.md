## MODIFIED Requirements

### Requirement: Authoring tools are consolidated into `flow_agents` and `flow_write`

pi-flows SHALL expose exactly two authoring tools on the main session: `flow_agents` and `flow_write`. The former `agent_catalog`, `agent_write`, and the raw-path form of `flow_write` SHALL NOT be exposed as separate main-session tools. Both tools SHALL derive their write locations from the discovery convention and SHALL NOT accept a raw filesystem `path` parameter.

`flow_agents op:"list"` SHALL return the agent catalog in `content[0].text` (pretty-printed JSON, unchanged) AND SHALL populate the tool result `details` with a structured, non-truncated catalog: `{ count: <number>, agents: Array<{ name, description, source_type, source_path?, tools?, inputs?, outputs?, use_when }> }`. `count` SHALL equal the number of discovered agents. Each entry's `use_when` SHALL be `architect.use_when` when present, else the agent's `description`. `source_path` SHALL be present only for non-built-in agents. Absent optional fields SHALL be omitted from the entry.

#### Scenario: `flow_agents` lists and writes agents
- **WHEN** `flow_agents` is called with `op: "list"`
- **THEN** it SHALL return the agent catalog (the data formerly returned by `agent_catalog`)
- **WHEN** `flow_agents` is called with `op: "write"` and a valid agent definition
- **THEN** it SHALL write the agent to the discovery-derived location and trigger re-discovery

#### Scenario: `op:"list"` populates a structured details catalog
- **WHEN** `flow_agents` is called with `op: "list"` and N agents are discovered
- **THEN** the tool result `details` SHALL be `{ count: N, agents: [...] }` with `agents.length === N`
- **AND** each entry SHALL carry `name`, `description`, and `source_type`
- **AND** the `content[0].text` JSON payload SHALL be unchanged from the prior behavior

#### Scenario: details entry flattens use_when and omits absent fields
- **WHEN** an agent has no `architect` block
- **THEN** its `details.agents` entry `use_when` SHALL equal the agent's `description`
- **AND** a built-in agent's entry SHALL NOT include `source_path`
