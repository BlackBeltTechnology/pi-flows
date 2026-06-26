# Design — Rename `edit-flow` → `manage-flows`

## Context

The skill name is load-bearing in three coupled places (verified in source):

1. `extensions/flow-engine/edit-flow-skill.ts:18` — `const SKILL_NAME = "edit-flow"`. Used to build both the packaged template path (`skills/<name>/SKILL.md`) and the project-local materialized path (`.pi/skills/<name>/SKILL.md`).
2. The packaged directory `skills/edit-flow/SKILL.md` — pi discovers it and registers the `/skill:edit-flow` command from the frontmatter `name`.
3. The frontmatter `name: edit-flow` inside that SKILL.md — the routing identity and the `/skill:` command stem.

Because `SKILL_NAME` is used to **read** the packaged template and **write** the project-local copy, the constant, the directory, and the frontmatter name must change together or the gate breaks (it would read a path that no longer exists). This is why a "label-only" rename is impossible: `/skill:<name>` is derived from the same `name` the gate pins on.

## Decisions

### D1: Rename the skill name, keep the setting key and command name
- **What:** `edit-flow` (skill) → `manage-flows`. Keep `flows.editFlow` (setting) and `/flows:edit-mode` (command).
- **Why:** The confusion is the *skill* label that users invoke (`/skill:edit-flow`) and read in docs. The `flows.editFlow` key names the capability flag, is rarely seen by users (hand-editing settings is the escape hatch, not the path), and renaming it adds a second settings migration for zero perceptual gain. `/flows:edit-mode` already reads correctly ("edit mode" = authoring mode).

### D2: No migration — unreleased
- **What:** Do not add any orphan-cleanup logic. The `edit-flow` name never shipped, so no installed project has a stale `.pi/skills/edit-flow/` copy. The one stale copy in this dev repo is deleted by hand as part of the rename and re-materializes as `manage-flows` on next session start.
- **Why:** Cleanup code would exist solely for a migration that has no audience. Simplicity-first: don't ship machinery for a non-existent population.

### D3: Internal source filenames stay `edit-flow-*.ts`
- **What:** Do **not** rename `edit-flow-skill.ts` / `edit-flow-config.ts`.
- **Why:** These are internal module names tied to the `flows.editFlow` *setting* (which keeps its name), not to the skill's user-facing label. Renaming files churns imports and git history for no external benefit. Surgical-change principle: touch only what the user-facing rename requires.

### D4: Cleanup is idempotent and bounded
- **What:** The stale-dir removal only targets the exact legacy path `.pi/skills/edit-flow/` and only the files the system originally materialized (`SKILL.md`); it must not recursively delete unrelated user content.
- **Why:** Defensive — a user could have put unrelated files in that directory. Remove the known artifact; if the directory is then empty, remove it; otherwise leave it.

## Open questions

- None blocking. Confirm during implementation that pi's skill discovery picks up the renamed packaged directory without a manifest change (the `pi.skills` manifest points at the `skills/` parent dir, so a child rename should be transparent — verify).
