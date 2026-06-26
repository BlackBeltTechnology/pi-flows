# Rename the `edit-flow` skill to `manage-flows`

## Why

The authoring skill is named `edit-flow`, but it does **both** jobs: it creates new flows/agents *and* edits existing ones (editing is "write to a name that already exists" — `flow_write`/`flow_agents` overwrite). The skill description already leads with "Create **and** edit", and the model routes on that description — so model selection is correct.

The problem is **human perception**, not model routing. A user who wants to *build* a flow sees `/skill:edit-flow` and `/flows:edit-mode` and the literal string `edit-flow` across the docs, reads "edit", and assumes the surface is modify-only. The label undersells the create path and confuses users at the point of invocation.

`manage-flows` honestly spans the full surface (create + edit + delete) and stops reading as "modify-only".

## What changes

Rename the skill `edit-flow` → `manage-flows` everywhere the **name** is load-bearing. Because pi derives the `/skill:<name>` command from the frontmatter `name`, and the edit-mode gate's pin (`SKILL_NAME` constant in `edit-flow-skill.ts`) must equal that name to materialize `.pi/skills/<name>/SKILL.md` and flip `disable-model-invocation`, all three move together as one coordinated rename:

- **Skill `name` frontmatter + packaged directory:** `skills/edit-flow/SKILL.md` → `skills/manage-flows/SKILL.md`, frontmatter `name: manage-flows`. The `/skill:` command becomes `/skill:manage-flows`.
- **Gate pin:** `SKILL_NAME = "edit-flow"` → `"manage-flows"` in `edit-flow-skill.ts`. The materialized project-local path becomes `.pi/skills/manage-flows/SKILL.md`.
- **No migration.** This version is unreleased — the `edit-flow` name never shipped, so there are no existing installs to migrate. The stale project-local `.pi/skills/edit-flow/` copy in this dev repo is removed as part of the rename; it re-materializes as `manage-flows` on the next session start.
- **Docs/prose:** update `/skill:edit-flow` and `edit-flow`-as-skill-name mentions across `README.md`, `AGENTS.md`, and `docs/*.md` (+ `agent-docs/` mirror) to `manage-flows`.

The `flows.editFlow` **setting key** stays unchanged (it names the *capability flag*, not the skill, and renaming it is gratuitous churn with its own migration cost). The `/flows:edit-mode` command name stays unchanged.

## Impact

- **Affected specs:** `edit-mode` — the skill-name in the visibility-coupling and toggle requirements changes from `edit-flow` to `manage-flows`.
- **Affected code:** `extensions/flow-engine/edit-flow-skill.ts` (`SKILL_NAME` constant, stale-dir cleanup), `extensions/flow-engine/index.ts` and `edit-flow-config.ts` (log/comment strings referencing the skill name), the packaged `skills/edit-flow/` directory (rename to `skills/manage-flows/`).
- **Docs:** `README.md` ×2, `AGENTS.md` ×1, `docs/flow-authoring.md`, `docs/tools-reference.md`, `docs/dashboard-integration.md`, `docs/events-api.md` (+ `agent-docs/flow-authoring.md` mirror) — all `/skill:edit-flow` / `edit-flow` skill-name references. (The internal source filenames `edit-flow-skill.ts` / `edit-flow-config.ts` and the `flows.editFlow` setting are intentionally left as-is.)
- **Backward compatibility:** not a concern — unreleased. `flows.editFlow` setting and `/flows:edit-mode` command are unchanged regardless.
- **Out of scope:**
  - Renaming the `flows.editFlow` settings key or the `/flows:edit-mode` command.
  - Renaming internal source files (`edit-flow-skill.ts`, `edit-flow-config.ts`).
  - Any change to `flow_agents`/`flow_write` tool names or behavior.
  - Splitting authoring into separate create/edit skills (explicitly rejected — one capability, one gate, one tool pair).
