## 1. Failing tests first

- [x] 1.1 Validation test: a flow/step declaring `on_complete` produces an error naming the removed field + migration path (blockedBy / decision).
- [x] 1.2 Routing test (faux harness): a plain code/agent node that succeeds falls through to the next step in file order (no jump, no skip).
- [x] 1.3 Reference-ordering test: a `${{result.A}}` reference previously satisfied by `on_complete: B` chain now FAILS validation unless `blockedBy`/`on_error`/branch proves ordering.
- [x] 1.4 Run new tests; confirm they fail for the right reasons.

## 2. Remove the field + parsing

- [x] 2.1 Delete `on_complete?` from `AgentStep` and `CodeStep` in `types.ts` (and the type-doc comment).
- [x] 2.2 Stop parsing `on_complete` in `flow-parser-yaml.ts` (both agent + code step parsers).

## 3. Routing: success falls through

- [x] 3.1 `flow-execution.ts`: success arm yields no target — route only on `soft → on_error`; hard still halts. Update `executeAgentStepWithRouting`, `executeCodeStepWithRouting`, and the `runDagSegment` success branch (delete the on-success reachable-narrowing).
- [x] 3.2 Update comments in `failure.ts` / `flow-execution.ts` that describe `success → on_complete`.
- [x] 3.3 Confirm 1.2 passes.

## 4. Validation

- [x] 4.1 `flow-validate.ts`: replace the `on_complete` reference-existence check with a removed-field error (actionable migration message).
- [x] 4.2 Drop `on_complete` from the reference-ordering graph-edge builder.
- [x] 4.3 Update the single-branch decision suggestion text (no longer mentions `on_complete`).
- [x] 4.4 Confirm 1.1, 1.3 pass.

## 5. Display

- [x] 5.1 Remove `on_complete` from `flow-tui.ts` route-edge extraction and `flow-preview-overlay.ts` rendering.

## 6. Update existing tests to the fall-through model

- [x] 6.1 Update `code-node-parser`, `failure-model`, `code-node-validation`, `wiring-validation`, `flow-started-route-fields`, `code-node-e2e` to remove `on_complete` and assert fall-through / rejection.

## 7. Docs (delegate `docs/` writes to a subagent)

- [x] 7.1 `docs/flows.md`, `docs/flow-authoring.md`, `docs/public-api.md`: remove `on_complete`; add migration note (blockedBy / decisions).
- [x] 7.2 `skills/manage-flows/SKILL.md`: remove `on_complete` references / suggestion.
- [x] 7.3 `CHANGELOG.md`: BREAKING entry (direct edit).

## 8. Verify + commit

- [x] 8.1 `npm run lint && npm run typecheck && npm test` green.
- [x] 8.2 `openspec validate remove-on-complete-routing`.
- [x] 8.3 Commit.
