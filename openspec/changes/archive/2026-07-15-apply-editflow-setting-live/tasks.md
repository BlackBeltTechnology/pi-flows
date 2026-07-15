> Note: the faux flow/agent harness does not exercise the main-session
> tool-gating lifecycle (`activate`/`session_start`/`before_agent_start`/
> `getActiveTools`/`setActiveTools`), so tests target the extracted change-gated
> reconciler helper directly — matching this repo's existing mock-`pi` /
> helper-level edit-flow tests.

## 1. Failing test first

- [x] 1.1 Test `makeEditFlowToolReconciler`: starting from unset, `reconcile(false)` leaves `flow_agents`/`flow_write` inactive; a subsequent `reconcile(true)` adds them to the active set (simulating an on-disk enable picked up on the next turn).
- [x] 1.2 Test (reverse): from enabled, `reconcile(false)` removes the authoring tools from the active set.
- [x] 1.3 Test: a repeated `reconcile(x)` with an unchanged value returns `false` and does NOT call `setActiveTools` again (change-gated — no redundant prompt rebuild); it preserves non-edit-flow tools in the active set.
- [x] 1.4 Run the new tests; confirm red.

## 2. Implement the per-turn reconcile

- [x] 2.1 Add `extensions/flow-engine/edit-flow-reconcile.ts` exporting `makeEditFlowToolReconciler({ getActiveTools, setActiveTools, editFlowTools })` — a change-gated `reconcile(enabled): boolean` closure holding the last-applied value.
- [x] 2.2 In `index.ts`, build the reconciler and use it as the single reconcile path (replacing the stateless inline closure) for `session_start` (seeds the cache) and the new `pi.on("before_agent_start", …)` (resolves `isEditFlowEnabled(projectRoot, { projectTrusted: ctx.isProjectTrusted() })` then `reconcile(enabled)`); existing `applyEditMode` command/event calls keep calling the same reconciler.
- [x] 2.3 Do not change the command/event handler logic or skill-visibility wiring (only the reconcile helper's implementation and the added turn hook; the trust gate is removed separately in §2b).
- [x] 2.4 Confirm 1.1–1.3 pass.

## 2b. Remove the project-trust gate on `flows.editFlow`

- [x] 2b.1 Flip `__tests__/edit-flow-config.test.ts`: drop `projectTrusted`; assert the project setting is honored regardless of trust and overrides global. Confirm red.
- [x] 2b.2 `edit-flow-config.ts`: drop the `projectTrusted` parameter from `isEditFlowEnabled`; always read the project `.pi/settings.json` (project overrides global; global always honored). Update the header comment.
- [x] 2b.3 `index.ts`: stop resolving `ctx.isProjectTrusted()` in the `session_start` and `before_agent_start` handlers; call `isEditFlowEnabled(projectRoot)`.
- [x] 2b.4 Spec: add `specs/flow-authoring/spec.md` MODIFIED delta flipping the "gated by `flows.editFlow`" requirement from trusted-only to honored-regardless-of-trust; update the `edit-mode` delta's trust wording + scenario. Confirm config tests pass.

## 3. Docs

- [x] 3.1 (Edited directly per user instruction.) Update `docs/tools-reference.md` and `docs/flow-authoring.md`: the per-turn tools reconcile, the tools-live / skill-on-reload asymmetry, and `flows.editFlow` honored regardless of trust.
- [x] 3.2 `CHANGELOG.md`: note that `flows.editFlow` now applies to a running session per turn without a restart.

## 4. Verify

- [x] 4.1 `npm run lint && npm run typecheck && npm test` green.
- [x] 4.2 `openspec validate apply-editflow-setting-live --strict`.
