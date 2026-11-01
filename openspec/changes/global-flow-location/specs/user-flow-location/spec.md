# Spec Delta

## Purpose

Lets a user keep flows and agents in their pi agent directory so every project can run them, the same way pi treats user-level skills.

## ADDED Requirements

### Requirement: Flows and agents are discovered from the user agent directory

pi-flows SHALL discover flows from `<agentDir>/flows/flows/<namespace>/<name>/flow.yaml` and agents from `<agentDir>/flows/agents/*.md`, where `<agentDir>` is pi's agent directory (`getAgentDir()`). A missing directory SHALL be ignored without a warning.

#### Scenario: User flow available in any project
- **GIVEN** `~/.pi/agent/flows/flows/batch/apply/flow.yaml` AND a project without `.pi/flows/`
- **WHEN** a session starts in that project
- **THEN** the command `/batch:apply` SHALL be registered

#### Scenario: Custom agent directory
- **GIVEN** `PI_CODING_AGENT_DIR=/tmp/agent` AND `/tmp/agent/flows/agents/reviewer.md`
- **WHEN** flows are discovered
- **THEN** the agent `reviewer` SHALL be available

#### Scenario: No user directory
- **WHEN** `<agentDir>/flows/` does not exist
- **THEN** discovery SHALL succeed with no warning about it

### Requirement: Project overrides user, user overrides packages and built-ins

On a flow or agent name clash pi-flows SHALL use the project item, else the user item, else a package item, else the built-in.

#### Scenario: Project flow wins
- **GIVEN** a user flow `batch:apply` AND a project flow `batch:apply`
- **WHEN** `/batch:apply` runs
- **THEN** the project flow SHALL run

#### Scenario: User agent overrides built-in
- **GIVEN** a user agent named `flow-decision`
- **WHEN** a decision uses `flow-decision`
- **THEN** the user agent SHALL be used

### Requirement: User flows run in the current project

A user flow SHALL load its code handlers from its own flow directory, and SHALL run with the starting session's project as `ctx.cwd`, as the agents' working directory and as the location of run results.

#### Scenario: Handler from the user directory, work in the project
- **GIVEN** a user flow with code step `load-plan` and handler `load-plan.ts` beside its `flow.yaml`
- **WHEN** the flow runs from project `/work/app`
- **THEN** the handler SHALL be loaded from the user flow directory AND `ctx.cwd` SHALL be `/work/app`

#### Scenario: Results stay in the project
- **WHEN** a user flow finishes in project `/work/app`
- **THEN** its result file SHALL be written under `/work/app/.pi/flows/results/`

### Requirement: Listings show where each flow and agent comes from

`/flows` and `flow_agents` op `list` SHALL label each flow and agent with its source: `project`, `user`, `package` or `built-in`.

#### Scenario: User flow labelled
- **GIVEN** a user flow `batch:apply`
- **WHEN** the user opens `/flows`
- **THEN** `batch:apply` SHALL be labelled `user`

### Requirement: Authoring tools can write to the user location

`flow_write` and `flow_agents` op `write` SHALL accept `scope: "project" | "user"`, default `project`. With `user` they SHALL write under `<agentDir>/flows/` with the same layout and validation as project writes, and trigger re-discovery.

#### Scenario: Write a user flow
- **WHEN** `flow_write` is called with `namespace: "batch"`, `name: "apply"`, `scope: "user"` and valid content
- **THEN** the file SHALL be written to `<agentDir>/flows/flows/batch/apply/flow.yaml` AND `/batch:apply` SHALL be available after re-discovery

#### Scenario: Default stays project
- **WHEN** `flow_write` is called without `scope`
- **THEN** the file SHALL be written under the project's `.pi/flows/flows/`

#### Scenario: Invalid scope rejected
- **WHEN** `flow_write` is called with `scope: "global"`
- **THEN** the tool SHALL return a validation error naming the allowed values and write nothing

### Requirement: Deleting a flow uses its own location

`/flows:delete` SHALL delete a flow from the directory it was discovered in, and its confirmation SHALL name that path. Package and built-in flows SHALL NOT be deletable.

#### Scenario: Delete a user flow
- **GIVEN** a user flow `batch:apply` and no project flow of that name
- **WHEN** the user deletes `batch:apply` and confirms
- **THEN** `<agentDir>/flows/flows/batch/apply/` SHALL be removed AND the confirmation SHALL have shown that path

#### Scenario: Built-in not deletable
- **WHEN** the user tries to delete a package or built-in flow
- **THEN** pi-flows SHALL refuse with a message naming the source
