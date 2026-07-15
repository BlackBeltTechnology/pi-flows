## ADDED Requirements

### Requirement: Setting changes apply to a running session per turn
The system SHALL re-read `flows.editFlow` and reconcile the `flow_agents`/`flow_write`
authoring tools at each agent turn start, so that an out-of-band change to the
setting (e.g. a direct edit of `.pi/settings.json` while a session is running)
takes effect on the session's next agent turn without requiring a restart. The
flag SHALL be resolved with the same trust rule used at session start (the project
setting is honored only when the project is trusted; the global setting is always
honored). This applies to the authoring **tools** only; skill prompt-visibility
remains coupled to session start / reload.

#### Scenario: On-disk enable is picked up on the next turn
- **WHEN** `flows.editFlow` is `false`/unset and, while the session is running, it is changed to `true` on disk
- **THEN** on the next agent turn the `flow_agents`/`flow_write` tools become active without a session restart

#### Scenario: On-disk disable is picked up on the next turn
- **WHEN** edit-mode is active and, while the session is running, `flows.editFlow` is changed to `false` on disk
- **THEN** on the next agent turn the authoring tools are deactivated without a session restart

#### Scenario: Unchanged setting does not rebuild the tool set
- **WHEN** consecutive turns occur and the resolved `flows.editFlow` value has not changed
- **THEN** the tools are not reconciled again (no redundant system-prompt rebuild)

#### Scenario: Trust rule is preserved
- **WHEN** the per-turn re-read resolves the flag in an untrusted project
- **THEN** the project `.pi/settings.json` value is ignored exactly as at session start, and only the global setting (or the default) applies
