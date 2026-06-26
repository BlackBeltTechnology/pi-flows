## 1. Rename the packaged skill

- [x] 1.1 Rename directory `skills/edit-flow/` → `skills/manage-flows/` (git mv)
- [x] 1.2 Set frontmatter `name: manage-flows` in the moved `SKILL.md`
- [x] 1.3 Update the skill body's self-references (`# Edit Flow` title, "edit-flow tools" mention)
- [x] 1.4 `package.json` `pi.skills` points at the `skills/` parent dir — no manifest change needed

## 2. Repoint the gate pin (edit-flow-skill.ts)

- [x] 2.1 Change `SKILL_NAME = "edit-flow"` → `"manage-flows"` (now resolves `.pi/skills/manage-flows/SKILL.md` and `skills/manage-flows/SKILL.md`)
- [x] 2.2 Update the module comment + fallback template heading to `manage-flows` / `# Manage Flows`
- [x] 2.3 Remove the stale project-local `.pi/skills/edit-flow/` copy in this repo (re-materializes as `manage-flows`)

## 3. String references in code

- [x] 3.1 Update the `/skill:edit-flow` comment in `index.ts` → `/skill:manage-flows` (left the `flows.editFlow` setting and `edit-flow-*.ts` filenames unchanged)

## 4. Docs & prose

- [x] 4.1 `README.md` (×2) `/skill:edit-flow` → `/skill:manage-flows`
- [x] 4.2 `AGENTS.md` (×1) command list reference
- [x] 4.3 `docs/*` + `agent-docs/*` skill-name references (delegated to a general-purpose subagent)
- [x] 4.4 `CHANGELOG.md` entry under [Unreleased] noting the skill rename

## 5. Spec & validation

- [x] 5.1 Apply the `edit-mode` spec delta (skill-name change in visibility + toggle requirements)
- [x] 5.2 `openspec validate rename-edit-flow-to-manage-flows --strict` passes
- [x] 5.3 `npm run lint && npm run typecheck && npm test` — all green (298 tests; updated 2 stale assertions in `edit-mode-toggle.test.ts`)
