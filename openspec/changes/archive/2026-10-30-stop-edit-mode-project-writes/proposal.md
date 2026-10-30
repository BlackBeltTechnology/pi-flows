# Proposal

## Why

pi-flows writes into the working tree of every repo the user opens. On every `session_start` it materializes or rewrites `<repo>/.pi/skills/manage-flows/SKILL.md`, and the dashboard's automatic `flow:set-edit-mode` reconcile also writes `<repo>/.pi/settings.json`. That leaves `git status` dirty in repos where nobody asked for edit mode. pi-agent-dashboard is moving to a global-only toggle (`~/.pi/agent/settings.json#flows.editFlow`). With that change, a single user-level flip would dirty every repo that has the skill file committed. pi-flows has to stop making implicit project writes. (Dashboard counterpart: `stop-flows-edit-mode-project-writes`.)

## What Changes

- **BREAKING (behavioural):** `session_start` no longer creates or modifies any file under the project root. The project-local `.pi/skills/manage-flows/SKILL.md` is no longer materialized or synced, either at session start or on the explicit toggle.
- The `manage-flows` skill is shipped and registered from the package itself (`pi.skills` manifest entry). It is always reachable through `/skill:manage-flows`.
- Whether the skill is visible to the model is computed **per agent run, in memory**, from the effective `flows.editFlow` value (project overrides global, default off). This is the same per-turn re-read that already gates `flow_agents`/`flow_write`. No file is written.
- The visibility decision is made by skill **name**, so a leftover project copy from the old behaviour, with either frontmatter value, follows the effective setting without being touched.
- Global setting changes now apply live to both tools and skill visibility on the next turn.
- `/flows:edit-mode <on|off>` and `flow:set-edit-mode` still write `flows.editFlow` to the project `.pi/settings.json`, because the user asked for it explicitly. The write is skipped when the value is already set. They no longer call `ctx.reload()`, since there is no skill file to re-discover. Both surfaces now behave the same and take effect on the next turn.
- The now-unused project-skill materialization module is removed.
- CHANGELOG note: existing repo files are left alone. A leftover project `flows.editFlow: false` overrides the global value, so delete that key to follow the global setting. A leftover `.pi/skills/manage-flows/` triggers pi's duplicate-skill-name warning and can be deleted.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `edit-mode`: skill visibility is no longer coupled through a project-local file. It is computed per run from the effective setting. Live-reload on toggle is removed. The per-turn re-read now also covers skill visibility. A new requirement forbids implicit project writes.

## Impact

- Code: `extensions/flow-engine/index.ts` (session_start, before_agent_start, applyEditMode, the `flows:edit-mode` command), `extensions/flow-engine/edit-flow-skill.ts` (removed), `extensions/flow-engine/edit-flow-config.ts` (no-op write skip), `package.json` (`pi.skills`).
- Tests: `__tests__/edit-mode-toggle.test.ts` (drop the materialization suites, add no-write, visibility, and idempotence checks).
- Docs: `docs/flow-authoring.md`, `docs/tools-reference.md`, `docs/events-api.md`, `docs/dashboard-integration.md`, `README.md`, `CHANGELOG.md`.
- Dashboard contract: `flow:set-edit-mode` payload unchanged. Tool activation stays the observable edit-mode signal.

## Discipline Skills

`doubt-driven-review` (behavioural change for existing users and a cross-repo contract with pi-agent-dashboard).
