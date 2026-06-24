## ADDED Requirements

### Requirement: A `flow-authoring` skill ships with the package

pi-flows SHALL ship a native pi skill at `skills/flow-authoring/SKILL.md`, and `skills/` SHALL be listed in `package.json#files` so it is published. The skill SHALL be discoverable by pi as the `/skill:flow-authoring` command and SHALL teach: agent frontmatter schema, flow YAML structure, the step types, minimal examples, the discovery-based write locations, and how to fix common validation errors. The skill SHALL cover both creating new flows/agents and editing existing ones (edit = read the existing file, then rewrite).

#### Scenario: Skill is published and discoverable

- **WHEN** pi loads the pi-flows package
- **THEN** a skill named `flow-authoring` SHALL be discovered from `skills/flow-authoring/SKILL.md`
- **AND** it SHALL be invocable as `/skill:flow-authoring`
- **AND** `package.json#files` SHALL include `skills/`

#### Scenario: Skill teaches both authoring and editing

- **WHEN** a user reads the `flow-authoring` skill
- **THEN** the content SHALL describe how to create a new flow/agent using the authoring tools
- **AND** SHALL describe how to edit an existing flow/agent by reading it and rewriting via the same tools

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
- **AND** on success SHALL write to `.pi/flows/flows/<namespace>/<name>.yaml`
- **AND** the written flow SHALL auto-register as the `/<namespace>:<name>` command
- **AND** when `namespace` is omitted it SHALL default to `custom`
- **AND** writing to an existing `<namespace>/<name>.yaml` SHALL overwrite it (edit), with no separate edit tool

#### Scenario: Validation failure does not write

- **WHEN** `flow_write` or `flow_agents` (op `write`) is called with content that fails validation
- **THEN** no file SHALL be written
- **AND** the tool SHALL return the validation diagnostics so the caller can self-correct

### Requirement: Authoring tools are gated behind `/flows:author`

pi-flows SHALL register `flow_agents` and `flow_write` as inactive by default, so they do not appear in any session's system prompt until activated. pi-flows SHALL register a `/flows:author` command that activates both tools via `pi.setActiveTools()` and primes the `flow-authoring` skill.

#### Scenario: Tools absent by default

- **WHEN** a pi session starts with pi-flows loaded and `/flows:author` has not been invoked
- **THEN** `flow_agents` and `flow_write` SHALL NOT be in `pi.getActiveTools()`

#### Scenario: `/flows:author` activates tools and primes the skill

- **WHEN** the user invokes `/flows:author`
- **THEN** `flow_agents` and `flow_write` SHALL be added to the active tool set via `pi.setActiveTools()`
- **AND** the `flow-authoring` skill content SHALL be primed into the session
- **AND** the previously active tools SHALL remain active

### Requirement: `/flows` menu offers list, run, and delete only

The `/flows` interactive menu SHALL offer listing, running, and deleting flows. It SHALL NOT offer "New flow" or "Edit" entries. Where appropriate it SHALL point users to `/flows:author`.

#### Scenario: Menu has no New/Edit entries

- **WHEN** the user opens the `/flows` menu
- **THEN** there SHALL be no entry that spawns flow creation or editing
- **AND** list, run, and delete actions SHALL remain available
