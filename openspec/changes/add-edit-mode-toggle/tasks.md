## 1. Settings write helper (edit-flow-config.ts)

- [x] 1.1 Write tests: setting `flows.editFlow` preserves other keys (read-merge-write); creates `.pi/settings.json` if absent; writes valid JSON
- [x] 1.2 Implement `setEditFlowFlag(projectRoot, enabled)` that read-merge-writes the project `.pi/settings.json` (never the global file)

## 2. Project-local skill materialization + frontmatter sync

- [x] 2.1 Write tests: materializes `.pi/skills/edit-flow/SKILL.md` from the packaged template when absent; sets `disable-model-invocation` to the correct boolean; never writes under `node_modules`
- [x] 2.2 Implement a helper that ensures the project-local copy exists (copy from pkg `skills/edit-flow/SKILL.md`) and writes/updates the `disable-model-invocation` frontmatter key (preserving the rest of the frontmatter + body)
- [x] 2.3 Confirm the packaged copy stays read-only and is the source only for the internal `skill_read`/subagent path (D3)
- [x] 2.4 Materialize/sync the project-local skill at `session_start` (idempotent) so it is discoverable by default with frontmatter reflecting current `flows.editFlow` — this is what makes the change also solve the skill-discovery issue (no `pi.skills` needed)

## 3. Shared toggle handler + command (index.ts / flow-context)

- [x] 3.1 Implement one `applyEditMode(enabled, { reload })` handler: write setting (1.2) → sync skill (2.2) → reconcile active tools (reuse the `session_start` EDIT_FLOW_TOOLS logic) → reload → notify
- [x] 3.2 Register `/flows:edit-mode <on|off>` command; parse arg (on/off, else usage); call `applyEditMode` with `ctx.reload`
- [x] 3.3 Write tests for arg parsing (on → true, off → false, invalid → usage/no-op)

## 4. Dashboard event surface (D5)

- [x] 4.1 Verify whether a reload-capable (`ExtensionCommandContext`) context is obtainable in an event handler — capture one at `session_start` if so
- [x] 4.2 Register `pi.events.on("flow:set-edit-mode", …)`; ignore payloads without a boolean `enabled`; call `applyEditMode`
- [x] 4.3 If no reload-capable context is available on the event path, perform the writes and notify that the change applies next session (graceful fallback per D5)

## 5. Docs & validation

- [x] 5.1 Update `docs/tools-reference.md` / `docs/flow-authoring.md` (+ `agent-docs/` mirror, delegated per AGENTS.md): document `/flows:edit-mode`, the `flow:set-edit-mode` event, and the project-local skill behavior
- [x] 5.2 Update `docs/dashboard-integration.md` (+ mirror): document the inbound `flow:set-edit-mode` event
- [x] 5.3 Run `npm run lint && npm run typecheck && npm test` — all green
- [x] 5.4 `openspec validate add-edit-mode-toggle --strict` passes
