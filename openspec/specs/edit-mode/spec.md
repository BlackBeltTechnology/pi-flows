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

### Requirement: Setting changes apply to a running session per turn
The system SHALL re-read `flows.editFlow` and reconcile the `flow_agents`/`flow_write`
authoring tools at each agent turn start, so that an out-of-band change to the
setting (e.g. a direct edit of `.pi/settings.json` while a session is running)
takes effect on the session's next agent turn without requiring a restart. The
flag SHALL be resolved the same way as at session start: the project
`.pi/settings.json` value overrides the global `~/.pi/agent/settings.json` value,
both honored regardless of project trust (there is no trust gate on this flag).
This applies to the authoring **tools** only; skill prompt-visibility remains
coupled to session start / reload.

Note (keep an eye on): this creates an intentional asymmetry when the setting is
flipped mid-run via an out-of-band edit — the **tools** reconcile on the next
turn, but the `manage-flows` skill's prompt-visibility does NOT change until a
reload (next session start, or the `/flows:edit-mode` command's `ctx.reload()`).
The reason is structural: turn/event handlers receive the base `ExtensionContext`,
which has no `reload()` (only the command context does), so a turn hook cannot
re-discover or re-parse skills. This is not a defect — the skill stays reachable
throughout via the explicit `/skill:manage-flows` command; only its silent
presence in the prompt lags. Worth watching if an upstream pi-coding-agent
release later exposes a reload-capable primitive on turn/event contexts, at which
point skill-visibility could also be made live.

#### Scenario: On-disk enable is picked up on the next turn
- **WHEN** `flows.editFlow` is `false`/unset and, while the session is running, it is changed to `true` on disk
- **THEN** on the next agent turn the `flow_agents`/`flow_write` tools become active without a session restart

#### Scenario: On-disk disable is picked up on the next turn
- **WHEN** edit-mode is active and, while the session is running, `flows.editFlow` is changed to `false` on disk
- **THEN** on the next agent turn the authoring tools are deactivated without a session restart

#### Scenario: Unchanged setting does not rebuild the tool set
- **WHEN** consecutive turns occur and the resolved `flows.editFlow` value has not changed
- **THEN** the tools are not reconciled again (no redundant system-prompt rebuild)

#### Scenario: Skill prompt-visibility is not changed by a per-turn re-read
- **WHEN** `flows.editFlow` is flipped on disk mid-run and the next agent turn reconciles the tools
- **THEN** the `manage-flows` skill's prompt-visibility is unchanged until a reload (next session start or the `/flows:edit-mode` command), and the skill remains reachable via the explicit `/skill:manage-flows` command

#### Scenario: No trust gate on the per-turn re-read
- **WHEN** the per-turn re-read resolves the flag in an untrusted project
- **THEN** the project `.pi/settings.json` value is honored exactly as at session start (no trust gate), overriding the global value

