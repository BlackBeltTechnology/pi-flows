## 1. Failing tests (write first, verify red)

- [x] 1.1 Parser test: `flow.yaml` with `auto_end: true` yields `FlowConfig.auto_end === true`; omission yields falsy.
- [x] 1.2 Gate test: flow with `auto_end: true` + non-interactive session + `status: success` → `shutdown()` called exactly once.
- [x] 1.3 Gate test: each of {flow key off, session interactive, status aborted, status error} → `shutdown()` NOT called.
- [x] 1.4 Ordering test: `shutdown()` is not invoked before `flow:complete` for the run has fired.
- [x] 1.5 Run all new tests and confirm they FAIL for the right reasons.

> Note: actual terminal success status is `"success"` (not `"complete"` as the proposal loosely worded it); implemented against `FlowResult.status === "success"`.

## 2. Flow key: `auto_end`

- [x] 2.1 Add `auto_end?: boolean` to `FlowConfig` in `extensions/flow-engine/types.ts`.
- [x] 2.2 Parse the top-level `auto_end` key in `extensions/flow-engine/flow-parser-yaml.ts` (default absent → falsy).
- [x] 2.3 Confirm 1.1 passes.

## 3. Non-interactive detection

- [x] 3.1 Cache an `isInteractive` flag from `ctx.hasUI` at `session_start` (before any flow can complete), reachable by the `flow:complete` listener.

## 4. Gate + shutdown wiring

- [x] 4.1 Register a `flow:complete` listener in `extensions/flow-engine/index.ts` that reads the completed flow's `auto_end` (from the `flows` map), checks the session is non-interactive, checks `status === "success"`, and calls `ctx.shutdown()` when all pass.
- [x] 4.2 Confirm 1.2, 1.3, 1.4 pass.

## 5. Docs (delegate `docs/` writes to a subagent)

- [x] 5.1 `docs/flow-authoring.md`: document the `auto_end` flow key.
- [x] 5.2 `docs/flows.md`: document auto-end behavior and the non-interactive gate.
- [x] 5.3 `CHANGELOG.md`: add entry (direct edit allowed).

## 6. Verify

- [x] 6.1 `npm run lint && npm run typecheck && npm test` all green.
- [ ] 6.2 Manual smoke: automation-style headless `flow:run` with `auto_end: true` → session closes on success; abort → stays open; interactive run → stays open. (Manual — owner to verify in a live session.)
