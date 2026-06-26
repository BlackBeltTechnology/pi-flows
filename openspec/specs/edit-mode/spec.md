# edit-mode Specification

## Purpose
TBD - created by archiving change add-edit-mode-toggle. Update Purpose after archive.
## Requirements
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

### Requirement: Setting persisted to the project settings file
The handler SHALL write `flows.editFlow` to the project `.pi/settings.json`, preserving all other keys (read-merge-write). It SHALL NOT write the global settings file.

#### Scenario: Other settings preserved
- **WHEN** edit-mode is toggled and `.pi/settings.json` already contains unrelated keys
- **THEN** only `flows.editFlow` is changed and all other keys are retained

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

### Requirement: Toggle takes effect immediately via live reload
After persisting the setting and skill frontmatter, the system SHALL trigger a live reload so skills are re-discovered and re-parsed and the authoring-tool gating re-runs, without requiring a manual session restart.

#### Scenario: Reload after a command toggle
- **WHEN** `/flows:edit-mode on` completes its writes
- **THEN** the command handler invokes the reload primitive and the new skill visibility and tool activation are in effect for the next turn

#### Scenario: Reload path for the event surface
- **WHEN** the `flow:set-edit-mode` event handler completes its writes
- **THEN** it triggers a reload via a command-capable context; if no reload-capable context is available, it notifies the user that the change applies on the next session start

