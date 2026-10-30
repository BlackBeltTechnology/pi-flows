# Tasks

## 1. Failing acceptance tests (done first, TDD)

- [x] 1.1 Write `__tests__/edit-mode-no-project-writes.test.ts` from the spec delta (no implicit writes, packaged registration, per-turn visibility, explicit toggle, no-op write skip) and verify it fails against current code: `npx vitest run __tests__/edit-mode-no-project-writes.test.ts` → 12 failed / 2 passed (the 2 passing are existing guards: global dirs and packaged SKILL.md never written)

## 2. Packaged skill registration

- [x] 2.1 Add `"skills": ["./skills"]` to the `pi` manifest in `package.json` and verify the "package manifest ships the manage-flows skill" test passes

## 3. Per-turn skill visibility

- [x] 3.1 Add the pure helper `applyManageFlowsVisibility(skills, enabled)` (design D2) with unit tests in `__tests__/edit-flow-reconcile.test.ts` covering: enabled → visible, disabled → hidden, a leftover copy flipped either way, other skills untouched. Verify with `npx vitest run __tests__/edit-flow-reconcile.test.ts`
- [x] 3.2 Call it from the existing `before_agent_start` handler in `extensions/flow-engine/index.ts`, reusing the same `isEditFlowEnabled` read as the tool reconcile, and verify the "Skill visibility follows the effective setting per turn" suite passes

## 4. Remove implicit and skill-file writes

- [x] 4.1 Remove the `syncEditFlowSkill` call from `session_start` and verify the "No implicit project writes" suite passes
- [x] 4.2 Reduce `applyEditMode` to `setEditFlowFlag` + `reconcileEditFlowTools` + a "from next turn" notify (no `syncEditFlowSkill`, no `ctx.reload()`), and verify the "Explicit toggle" command/event tests pass
- [x] 4.3 Make `setEditFlowFlag` skip the write when `flows.editFlow` already equals the requested value (design D5), and verify the "skips the write" test and the existing `setEditFlowFlag` suite in `__tests__/edit-mode-toggle.test.ts` pass
- [x] 4.4 Delete `extensions/flow-engine/edit-flow-skill.ts`, its suites in `__tests__/edit-mode-toggle.test.ts`, and its row in `extensions/flow-engine/AGENTS.md`. Verify with `grep -rn "edit-flow-skill\|syncEditFlowSkill" extensions __tests__` returning nothing

## 5. Documentation (docs/ edits delegated to a subagent)

- [x] 5.1 Update `docs/flow-authoring.md`, `docs/tools-reference.md`, `docs/events-api.md`, and `docs/dashboard-integration.md`: no project skill copy, visibility is per turn from the effective setting (global or project), no reload, and both surfaces apply from the next turn. Verify with `grep -rn "project-local\|ctx.reload\|next session start" docs/` returning no stale edit-mode statements
- [x] 5.2 Update the `README.md` edit-flow bullet (packaged skill, visibility follows the setting) and add a CHANGELOG "Behaviour change" entry covering: no repo writes on session start; leftover `.pi/skills/manage-flows/` can be deleted (duplicate-name warning); leftover project `flows.editFlow: false` overrides global, so delete the key to follow the global setting. Verify by reading the diff

## 6. Integration gate

- [x] 6.1 Run `npm run lint && npm run typecheck && npm test` and verify everything is green, including the full `edit-mode-no-project-writes` suite (14/14)
- [x] 6.2 Manual smoke in a scratch git repo with `pi install <this clone>`: start a session with edit-mode off, then with global `flows.editFlow: true`. Verify `git status` stays clean in both and the skill appears in the prompt only in the second

## Workflow follow-up

- Run `doubt-driven-review` on the behaviour change before commit (proposal Discipline Skills).
- Notify pi-agent-dashboard that pi-flows no longer writes on session start, so `stop-flows-edit-mode-project-writes` can proceed.
- Archive the change after review.
