# edit-mode Specification

## Purpose
TBD - created by archiving change add-edit-mode-toggle. Update Purpose after archive.
## Requirements
### Requirement: Edit-mode toggle from TUI and dashboard
The system SHALL expose a single edit-mode toggle reachable from both surfaces: a `/flows:edit-mode <on|off>` command (TUI) and a `flow:set-edit-mode { enabled: boolean }` event (dashboard). Both SHALL converge on one handler that applies the same state change.

#### Scenario: Command turns edit-mode on
- **WHEN** the user runs `/flows:edit-mode on`
- **THEN** the handler sets `flows.editFlow = true` in the project settings, activates `flow_agents`/`flow_write`, and the `manage-flows` skill is model-visible from the next agent turn of the current session

#### Scenario: Dashboard event turns edit-mode off
- **WHEN** the dashboard emits `flow:set-edit-mode` with `{ enabled: false }`
- **THEN** the handler sets `flows.editFlow = false` in the project settings, deactivates the authoring tools, and the skill is hidden from the model from the next agent turn

#### Scenario: Invalid command argument
- **WHEN** the user runs `/flows:edit-mode` with neither `on` nor `off`
- **THEN** the handler reports usage and makes no change

#### Scenario: Project toggle overrides global
- **WHEN** the global `flows.editFlow` is `false` and the user runs `/flows:edit-mode on` in a repository
- **THEN** the project `.pi/settings.json` contains `flows.editFlow: true` and edit-mode is on for that repository

### Requirement: Setting persisted to the project settings file
The handler SHALL write `flows.editFlow` to the project `.pi/settings.json`, preserving all other keys (read-merge-write). It SHALL NOT write the global settings file. When the project file already holds the requested value, the handler SHALL NOT rewrite it.

#### Scenario: Other settings preserved
- **WHEN** edit-mode is toggled and `.pi/settings.json` already contains unrelated keys
- **THEN** only `flows.editFlow` is changed and all other keys are retained

#### Scenario: Unchanged value is not rewritten
- **WHEN** the project `.pi/settings.json` already has `flows.editFlow: true` and the user runs `/flows:edit-mode on`
- **THEN** the file's content and modification time are unchanged

#### Scenario: Toggle does not write a skill file
- **WHEN** edit-mode is toggled by command or event
- **THEN** no file under `.pi/skills/` is created or modified

### Requirement: No implicit project writes
The system SHALL NOT create, modify, or touch any file under the project root during session start, per-turn reconciliation, or any other path not explicitly triggered by an edit-mode toggle (`/flows:edit-mode` or `flow:set-edit-mode`). It SHALL NOT write the user-global settings or skills directories either.

#### Scenario: Clean repo with edit-mode off everywhere
- **WHEN** a session starts in a clean git repository and neither the global nor the project settings set `flows.editFlow`
- **THEN** no `.pi/skills/manage-flows/` directory and no `.pi/settings.json` is created, and `git status` reports no changes

#### Scenario: Clean repo with edit-mode enabled globally
- **WHEN** `~/.pi/agent/settings.json` sets `flows.editFlow: true` and a session starts in a clean git repository
- **THEN** the authoring tools are active, the `manage-flows` skill is visible to the model, and `git status` reports no changes

#### Scenario: Repeated session starts do not touch files
- **WHEN** sessions are started twice in the same project with no setting change in between
- **THEN** no file's modification time under the project root changes

#### Scenario: Leftover files from the old behaviour are left alone
- **WHEN** a project already contains `.pi/skills/manage-flows/SKILL.md` or `flows.editFlow` in `.pi/settings.json`
- **THEN** session start and per-turn reconciliation leave those files byte-identical

### Requirement: Packaged skill registration
The `manage-flows` skill SHALL be provided from the pi-flows package itself and SHALL be reachable via the explicit `/skill:manage-flows` command regardless of the edit-mode setting. The packaged skill file SHALL never be written.

#### Scenario: Skill available with edit-mode off
- **WHEN** edit-mode is off and the user runs `/skill:manage-flows`
- **THEN** the packaged skill content is loaded

### Requirement: Setting changes apply to tools and skill visibility per turn
The system SHALL re-read `flows.editFlow` at each agent turn start and apply it to both the `flow_agents`/`flow_write` tools and the `manage-flows` skill's prompt-visibility, so on-disk changes (project or global) take effect on the next turn without a restart. Project overrides global, with no trust gate.

#### Scenario: On-disk enable is picked up on the next turn
- **WHEN** `flows.editFlow` is `false`/unset and, while the session is running, it is changed to `true` on disk
- **THEN** on the next agent turn the `flow_agents`/`flow_write` tools become active and the `manage-flows` skill is listed to the model, without a session restart

#### Scenario: On-disk disable is picked up on the next turn
- **WHEN** edit-mode is active and, while the session is running, `flows.editFlow` is changed to `false` on disk
- **THEN** on the next agent turn the authoring tools are deactivated and the skill is no longer listed to the model, without a session restart

#### Scenario: Global change reaches a running session
- **WHEN** the project does not set `flows.editFlow` and the global `~/.pi/agent/settings.json` value is flipped while a session is running
- **THEN** both tools and skill visibility follow the new global value on the next agent turn

#### Scenario: Unchanged setting does not rebuild the tool set
- **WHEN** consecutive turns occur and the resolved `flows.editFlow` value has not changed
- **THEN** the tools are not reconciled again (no redundant tool-set rebuild)

#### Scenario: Leftover project skill copy follows the setting
- **WHEN** a project contains a leftover `.pi/skills/manage-flows/SKILL.md` whose frontmatter disagrees with the effective setting
- **THEN** the skill's prompt-visibility follows the effective setting, not the file's frontmatter, and the file is not modified

#### Scenario: No trust gate on the per-turn re-read
- **WHEN** the per-turn re-read resolves the flag in an untrusted project
- **THEN** the project `.pi/settings.json` value is honored exactly as at session start (no trust gate), overriding the global value
