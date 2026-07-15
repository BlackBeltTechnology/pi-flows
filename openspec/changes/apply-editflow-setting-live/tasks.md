## 1. Failing test first

- [ ] 1.1 Faux-model test: start a session with `flows.editFlow` unset/false and confirm `flow_agents`/`flow_write` are inactive. While the session is running, flip `flows.editFlow` to `true` on disk (write `.pi/settings.json`) WITHOUT restarting, drive another agent turn, and assert the authoring tools are now active.
- [ ] 1.2 Faux-model test (reverse): with edit-mode active mid-session, flip `flows.editFlow` to `false` on disk, drive a turn, assert the tools deactivate — no restart.
- [ ] 1.3 Test: an unchanged setting across turns does NOT trigger a redundant `setActiveTools`/prompt rebuild (assert reconcile is gated by the cached value).
- [ ] 1.4 Run the new tests; confirm red.

## 2. Implement the per-turn reconcile

- [ ] 2.1 Add a module-scoped `lastEnabled` cache, seeded from the `session_start` resolution.
- [ ] 2.2 Add `pi.on("before_agent_start", …)`: resolve `isEditFlowEnabled(projectRoot, { projectTrusted: ctx.isProjectTrusted() })`; if it differs from `lastEnabled`, call `reconcileEditFlowTools(enabled)` and update the cache.
- [ ] 2.3 Do not touch the trust gate, the command path, the event path, or skill-visibility wiring.
- [ ] 2.4 Confirm 1.1–1.3 pass.

## 3. Docs

- [ ] 3.1 (Delegate to a subagent per repo doctrine.) Update `docs/tools-reference.md` and `docs/flow-authoring.md`: an out-of-band `flows.editFlow` change is picked up on the next agent turn (tools); skill visibility still applies on the next session start.
- [ ] 3.2 `CHANGELOG.md`: note that `flows.editFlow` now applies to a running session per turn without a restart.

## 4. Verify

- [ ] 4.1 `npm run lint && npm run typecheck && npm test` green.
- [ ] 4.2 `openspec validate apply-editflow-setting-live --strict`.
