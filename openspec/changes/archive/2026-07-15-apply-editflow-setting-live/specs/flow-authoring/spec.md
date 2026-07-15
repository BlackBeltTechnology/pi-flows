## MODIFIED Requirements

### Requirement: Authoring tools are gated by the `flows.editFlow` setting

pi-flows SHALL register `flow_agents` and `flow_write` as inactive by default, so they do not appear in any session's system prompt unless explicitly enabled. pi-flows SHALL, at each session start, read the `flows.editFlow` boolean from settings (a top-level `flowsEditFlow` boolean is also accepted) and reconcile the active tool set via `pi.setActiveTools()`: active when enabled, removed when not. The project setting in `.pi/settings.json` SHALL be honored regardless of project trust and SHALL override the global `~/.pi/agent/settings.json` value; the default when neither sets the flag SHALL be disabled. The `manage-flows` skill SHALL remain available as `/skill:manage-flows` regardless of the setting.

#### Scenario: Tools absent by default

- **WHEN** a pi session starts with pi-flows loaded and no `flows.editFlow` setting is enabled
- **THEN** `flow_agents` and `flow_write` SHALL NOT be in `pi.getActiveTools()`

#### Scenario: Setting activates tools at session start

- **GIVEN** `flows.editFlow: true` is set in the project's `.pi/settings.json` or in the global settings
- **WHEN** a pi session starts with pi-flows loaded
- **THEN** `flow_agents` and `flow_write` SHALL be in the active tool set via `pi.setActiveTools()`
- **AND** the previously active tools SHALL remain active

#### Scenario: Project setting overrides global, honored regardless of trust

- **WHEN** resolving the `flows.editFlow` flag
- **THEN** a value in the project `.pi/settings.json` SHALL be used regardless of whether the project is trusted
- **AND** a project value SHALL override the global value
- **AND** absence of the flag in both sources SHALL resolve to disabled
