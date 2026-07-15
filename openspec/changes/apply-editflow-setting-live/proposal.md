## Why

Edit-mode's authoring tools (`flow_agents`/`flow_write`) are gated by the
`flows.editFlow` setting, but that setting is only ever read once per session —
in the `session_start` handler (plus the `/flows:edit-mode` command and the
`flow:set-edit-mode` event handlers, which both push their own value). Nothing
re-reads the setting after the session is running.

As a result, when the setting is changed **out of band** — e.g. a user (or a
host) hand-edits `.pi/settings.json` while a session is already running — the
running session does not notice. The authoring tools do not appear or disappear
until the session is restarted, even though the on-disk setting has changed.

The apply primitive is already live: `setActiveTools` rebuilds the system prompt
and takes effect on the next agent turn, no reload required (this is exactly how
the `flow:set-edit-mode` event path already updates tools). What is missing is a
**trigger** — a point at which a running session re-reads the flag and reconciles
the tools. A turn boundary is the natural trigger, because tool-set changes take
effect on the next turn anyway, so re-checking at turn start loses nothing.

## What Changes

- Add a `before_agent_start` handler that re-reads `flows.editFlow`
  (`isEditFlowEnabled`, with the same `projectTrusted` argument already used at
  `session_start`) and calls the existing `reconcileEditFlowTools(enabled)`.
- Reconcile **only when the resolved value changed** since the last observed
  value (a cached `lastEnabled`), so an unchanged setting does not rebuild the
  system prompt on every turn.
- No change to the trust gate, the `/flows:edit-mode` command path, the
  `flow:set-edit-mode` event path, or skill-visibility semantics. Skill
  visibility remains coupled to `session_start`/reload as today; only the
  **tools** are reconciled live per turn (which is the observed gap).
- No file watcher, no `SettingsManager` coupling, no changes outside pi-flows.

## Capabilities

### Modified Capabilities
- `edit-mode`: the `flows.editFlow` setting is re-read and the authoring tools
  reconciled at each turn start, so an out-of-band setting change applies to a
  running session on its next turn without a restart.

## Impact

- **Code:** one added `pi.on("before_agent_start", …)` handler in
  `extensions/flow-engine/index.ts`, reusing the existing `isEditFlowEnabled`
  and `reconcileEditFlowTools`; a module-scoped `lastEnabled` cache to gate the
  reconcile. No new files, no new dependencies.
- **Behaviour:** flipping `flows.editFlow` on disk mid-session now takes effect
  on the next agent turn (tools activate/deactivate). Skill prompt-visibility is
  unchanged (still applies on the next session start / reload).
- **Out of scope:** removing or altering the trust gate; making skill visibility
  live; watching the settings file for instant (idle, no-turn) application.
