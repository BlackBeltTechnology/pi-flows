## 1. Types and parser

- [ ] 1.1 In `types.ts`, add `CodeDecisionStep` to the `FlowStep` union (extends code-node fields with `branches: Record<string,string>` and optional `max_iterations`).
- [ ] 1.2 In `types.ts`, extend `AgentDecisionStep` with optional `max_iterations` to support backward (loop) edges.
- [ ] 1.3 In `types.ts`, remove `ConditionalStep` and `AgentLoopDecisionStep` from the union and exports.
- [ ] 1.4 In `flow-parser-yaml.ts`, add `code-decision` inference/parse; reject `conditional` and `agent-loop-decision` with actionable migration error messages.
- [ ] 1.5 Update `flow-persist.ts` and any serialization to the new type set.

## 2. Routing and execution

- [ ] 2.1 In `execute-code-step.ts` (or a thin wrapper), extract the reserved `branch` output for `code-decision`, keeping the data-output validation/coercion path unchanged; forbid a declared data output named `branch`.
- [ ] 2.2 In `flow-execution.ts`, add `executeCodeDecisionStep` that reuses `executeCodeStep` then resolves `branch` against `branches:` (mirror `executeAgentDecisionStep`); off-map branch → hard fail.
- [ ] 2.3 Generalize branch routing so a branch target forming a backward edge increments the node's loop counter and forces exit at `max_iterations`; reuse `loopCounters`/`loopMaxIterations`.
- [ ] 2.4 Apply the same backward-edge support to `agent-decision` (subsumes former `agent-loop-decision`).
- [ ] 2.5 Ensure skipped forward siblings still receive synthetic `skipped` results and loop nodes settle to last-iteration outputs.
- [ ] 2.6 Wire `code-decision` into the `executeStep` switch and the separator-step scheduling path; remove `conditional`/`agent-loop-decision` cases.

## 3. Validation

- [ ] 3.1 In `tools/flow-validate.ts`, add: dangling branch target, `<2` branches on a `*-decision`, reserved-`branch`-as-data-output, and "backward edge requires `max_iterations`" checks.
- [ ] 3.2 Add unreachable-branch and cycle-without-cap detection; update `guard.ts` if it references removed types.

## 4. Scaffold generation

- [ ] 4.1 In `flow-generate.ts`, generate a `Branch` union from `branches:` keys for each `code-decision` and type the handler return as `Promise<{ branch: Branch } & <outputs>>`.
- [ ] 4.2 Reuse the `.default`-suffix non-overwrite behavior; ensure drift detection accounts for the `branch` field.

## 5. Dashboard events and TUI (nice-to-have, not blocking)

- [ ] 5.1 Emit `code-decision` lifecycle started/complete events tagged `kind: "code-decision"`; include enough payload to determine the taken branch.
- [ ] 5.2 Fire `flow:loop-iteration` for `code-decision`/`agent-decision` nodes that route along a backward edge, reusing the existing loop-counter bookkeeping (do NOT infer loop state from `max_iterations`).
- [ ] 5.3 Surface `code-decision` as a distinct `stepType`/`kind` in `flow-tui.ts` so the base card renders; confirm the existing ↻ iteration badge lights up for backward-edge nodes.
- [ ] 5.4 Update `flow-dashboard/flow-preview-overlay.ts`: render `code-decision`, detect loop arrows from backward edges in `branches:` topology (annotated with `max_iterations`), and drop the `agent-loop-decision`/`conditional` cases.

## 6. Tests

- [ ] 6.1 Update `__tests__/flow-dispatch.test.ts` for the new type set (remove conditional/agent-loop-decision cases).
- [ ] 6.2 Add tests: `code-decision` forward branch routing, branch + data outputs, off-map branch hard fail, reserved-name validation.
- [ ] 6.3 Add tests: backward-edge loop with `max_iterations` cap (both `code-decision` and `agent-decision`), last-iteration output semantics.
- [ ] 6.4 Add tests: validator errors (dangling target, single branch, missing `max_iterations`, `branch` data output).
- [ ] 6.5 Add tests: scaffold emits correct `Branch` union; parser migration errors for removed types.

## 7. Docs

- [ ] 7.1 Update `docs/flows.md` and `docs/flow-authoring.md`: new type set, `code-decision`, backward-edge loops, removal of `conditional`/`agent-loop-decision`, skip-empty contract (delegate to general-purpose subagent).
- [ ] 7.2 Mirror substance into `agent-docs/flows.md` and `agent-docs/flow-authoring.md` in caveman style (delegate to general-purpose subagent).
- [ ] 7.3 Add a CHANGELOG entry documenting the breaking removals and migration recipes.

## 8. Verify

- [ ] 8.1 Run `npm run lint`, `npm run typecheck`, `npm test` — all green.
- [ ] 8.2 Author a sample `code-decision` flow end-to-end (forward decision + a backward loop) and confirm routing + dashboard events.
