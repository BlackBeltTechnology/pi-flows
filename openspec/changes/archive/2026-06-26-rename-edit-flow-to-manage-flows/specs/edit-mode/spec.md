# edit-mode Specification (delta)

## MODIFIED Requirements

### Requirement: Skill visibility coupled to the toggle via a project-local copy
The system SHALL couple the `manage-flows` skill's model-visibility to edit-mode by writing `disable-model-invocation` into a project-local copy at `.pi/skills/manage-flows/SKILL.md`. The copy SHALL be materialized from pi-flows' packaged template when absent. The system SHALL NOT modify the packaged skill under `node_modules`.

#### Scenario: Enabling makes the skill model-visible
- **WHEN** edit-mode is turned on
- **THEN** the project-local `.pi/skills/manage-flows/SKILL.md` exists with frontmatter `disable-model-invocation: false`, so the model is told the skill exists

#### Scenario: Disabling hides the skill from the model
- **WHEN** edit-mode is turned off
- **THEN** the project-local copy's frontmatter is `disable-model-invocation: true`, excluding it from the prompt while keeping it reachable via the explicit `/skill:manage-flows` command

#### Scenario: Packaged skill is never mutated
- **WHEN** edit-mode is toggled
- **THEN** no file under `node_modules/.../pi-flows/skills/` is written

### Requirement: Edit-mode toggle from TUI and dashboard
The system SHALL expose a single edit-mode toggle reachable from both surfaces: a `/flows:edit-mode <on|off>` command (TUI) and a `flow:set-edit-mode { enabled: boolean }` event (dashboard). Both SHALL converge on one handler that applies the same state change.

#### Scenario: Command turns edit-mode on
- **WHEN** the user runs `/flows:edit-mode on`
- **THEN** the handler sets `flows.editFlow = true`, makes the `manage-flows` skill model-visible, activates `flow_agents`/`flow_write`, and the change takes effect in the current session

#### Scenario: Dashboard event turns edit-mode off
- **WHEN** the dashboard emits `flow:set-edit-mode` with `{ enabled: false }`
- **THEN** the handler sets `flows.editFlow = false`, hides the skill from the model, and deactivates the authoring tools

#### Scenario: Invalid command argument
- **WHEN** the user runs `/flows:edit-mode` with neither `on` nor `off`
- **THEN** the handler reports usage and makes no change
