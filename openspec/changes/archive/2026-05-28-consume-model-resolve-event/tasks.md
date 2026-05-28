## 1. Extract `autonomous-mode` out of `role-manager.ts`

- [x] 1.1 Create `extensions/autonomous-mode.ts` exporting `isAutonomousMode()`, `setAutonomousMode(enabled)`, and `activate(pi)`. The activate hook reads `autonomousMode` from `~/.pi/agent/providers.json` at startup, identical to current `role-manager.ts` behaviour.
- [x] 1.2 Update `extensions/index.ts` to call `activateAutonomousMode(pi)` instead of (eventually instead of) `activateRoleManager(pi)`.
- [x] 1.3 Update `extensions/flow-engine/flow-tui.ts` (and any other consumer) to import `isAutonomousMode` / `setAutonomousMode` from `../autonomous-mode.js` instead of `../role-manager.js`.
- [x] 1.4 Verify with a build that no module still imports `isAutonomousMode` from `role-manager.ts`.

## 2. Rewrite `resolveModel` around `model:resolve`

- [x] 2.1 Update `extensions/flow-engine/model-roles.ts::resolveModel` signature from `(model, thinking, getModelRole)` to `(pi, model, thinking)`. Preserve the return shape `{ modelId, thinkingLevel, model? }`.
- [x] 2.2 Implement the primary-then-fallback algorithm inside the new `resolveModel`:
   - emit `pi.events.emit("model:resolve", probe)` with `{ ref: model }`;
   - if `probe.model` set → use it;
   - else if `probe.error` set → throw with the handler's message;
   - else → in-process fallback against `pi.modelRegistry`:
     - `@role` → throw "no handler registered" with install hint;
     - `provider/model[:thinking]` → `registry.find(provider, id)`;
     - bare `model-id[:thinking]` → `registry.getAll().find(m => m.id === id)`.
- [x] 2.3 Update the four call sites of `resolveModel` to the new signature:
   - `extensions/flow-engine/execution.ts:185`
   - `extensions/flow-engine/flow-execution.ts:474`
   - `extensions/flow-workspace/index.ts:364`
   - `extensions/flow-workspace/index.ts:698`
- [x] 2.4 Remove the `getModelRole?:` parameter from `FlowEngineExecuteOptions` (or equivalent option bag in each callsite).
- [x] 2.5 Remove the `getModelRole` re-export from `extensions/flow-engine/index.ts`.

## 3. Delete `role-manager.ts` and its activation

- [x] 3.1 Remove `extensions/role-manager.ts`.
- [x] 3.2 Remove the `import { activate as activateRoleManager } from "./role-manager.js"` and its call from `extensions/index.ts`.
- [x] 3.3 Remove any other in-package imports of `role-manager` (audit via `grep -rn "role-manager" extensions/`).
- [x] 3.4 Confirm no `pi.events.on("flow:role-…)` listener remains anywhere in pi-flows after the delete.
- [x] 3.5 Confirm no `pi.events.on("model:resolve", …)` listener exists anywhere in pi-flows (per spec — pi-flows is a consumer, not a provider).

## 4. Update flow-architect documentation

- [x] 4.1 In `agents/flow-architect.md`, locate the section that documents agent-frontmatter fields and add a new sub-section titled "Model selection — accepted forms".
- [x] 4.2 The new section enumerates the three accepted `model:` forms with one example each: `@role` (preferred), `provider/model-id[:thinking]`, bare `model-id`.
- [x] 4.3 State explicitly: prefer `@role` for portability across operator setups; use bare or literal forms when a specific model is required regardless of role assignments.
- [x] 4.4 Update the "Complete Example" block to keep `@coding` for illustration, but reference the new section.

## 5. Tests

- [x] 5.1 Add `__tests__/model-resolution.test.ts` (or extend an existing test file) covering `resolveModel` with stubbed `pi.events` and `pi.modelRegistry`. Mirror the structure of `pi-dashboard-subagents/extensions/__tests__/model-resolve.test.ts`.
- [x] 5.2 Scenario: handler resolves `@role` → resolveModel returns the resolved Model.
- [x] 5.3 Scenario: handler resolves `provider/model` → same.
- [x] 5.4 Scenario: handler resolves bare `model-id` → same.
- [x] 5.5 Scenario: handler reports `probe.error` → resolveModel throws with that message.
- [x] 5.6 Scenario: silent emit + `provider/model` → fallback uses `registry.find()`.
- [x] 5.7 Scenario: silent emit + bare id → fallback uses `registry.getAll()`.
- [x] 5.8 Scenario: silent emit + `@role` → fallback throws "no handler" with install hint.
- [x] 5.9 Scenario: silent emit + unknown literal → fallback throws with models hint.
- [x] 5.10 Scenario: thinking suffix parsed correctly in both paths.
- [x] 5.11 Remove or adapt any existing tests that import / depend on `role-manager`.

## 6. Validation

- [x] 6.1 `npm test` — all tests pass.
- [x] 6.2 `npm run typecheck` — no errors.
- [x] 6.3 `npm run lint` — no new errors.
- [x] 6.4 `npm pack --dry-run` — confirm `role-manager.*` is NOT in the tarball.
- [x] 6.5 Manual smoke: load pi-flows alongside the updated pi-agent-dashboard, run a flow with `model: @coding`, confirm resolution succeeds.
- [x] 6.6 Manual smoke: load pi-flows WITHOUT pi-agent-dashboard, run a flow with `model: anthropic/claude-haiku-4-5`, confirm in-process fallback resolves correctly.
- [x] 6.7 `openspec validate consume-model-resolve-event` — green.

## 7. Companion-change coordination (tracked here)

> The `flow:role-*` event handlers, currently in `extensions/role-manager.ts`,
> need a new home in `pi-agent-dashboard`. Without that, the dashboard's
> `RolesSettingsSection.tsx` UI loses its backend.

- [x] 7.1 Open a corresponding change proposal in `pi-agent-dashboard` titled `adopt-role-management-from-pi-flows` (or similar). It MUST land before or together with this change.
- [x] 7.2 The companion change relocates the `flow:role-set` / `flow:role-get-all` / `flow:role-preset-load` / `flow:role-preset-save` / `flow:role-preset-delete` listeners into the dashboard, plus the in-memory roles cache + the `providers.json#roles` reader/writer.
- [x] 7.3 The companion change MAY leave the `flow:` prefix on the event names (for UI compatibility) — renaming to `roles:*` is out of scope.
