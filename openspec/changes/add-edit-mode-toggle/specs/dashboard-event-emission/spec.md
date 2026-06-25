## ADDED Requirements

### Requirement: Inbound `flow:set-edit-mode` event
pi-flows SHALL accept an inbound `flow:set-edit-mode` event carrying `{ enabled: boolean }`, emitted by the dashboard, and handle it identically to the `/flows:edit-mode` command (persist `flows.editFlow`, sync the project-local skill visibility, reconcile tools, live-reload).

#### Scenario: Dashboard drives edit-mode
- **WHEN** the dashboard emits `flow:set-edit-mode` with `{ enabled: true }`
- **THEN** pi-flows enables edit-mode (tools active, skill model-visible) for the session

#### Scenario: Payload without enabled is ignored
- **WHEN** a `flow:set-edit-mode` event arrives without a boolean `enabled`
- **THEN** pi-flows makes no change
