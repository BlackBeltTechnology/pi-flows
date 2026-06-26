## 1. Faux harness

- [x] 1.1 Add `__tests__/faux-harness.ts` exposing `makeFauxRegistry(faux)` → full ModelRegistry surface backed by `faux.models`.
- [x] 1.2 Add `spawnFaux({ agent, task, responses, signal?, modelApi? })` helper that registers a faux provider into pi-coding-agent's nested pi-ai, builds the registry + stub `pi`, and calls the real `spawnAgent` with `resolvedModelId` set.
- [x] 1.3 Add scripting shortcuts: `scriptFinish(args)`, `scriptToolThenFinish(name, args, finishArgs)`, `scriptError(message)`, `scriptSlowText(text)`.
- [x] 1.4 Verify harness compiles under `npm run typecheck` and a trivial finish test passes (`npm test`).

## 2. spawnAgent-level suites

- [x] 2.1 `__tests__/faux-spawn-finish.test.ts`: finish happy path (success + output wiring) and finish retry + first-correct-wins latch (bad then good).
- [x] 2.2 `__tests__/faux-spawn-tools.test.ts`: authorized tool dispatch through guard (recorded in `toolCalls`) and unauthorized-tool block.
- [x] 2.3 `__tests__/faux-spawn-abort.test.ts`: slow stream + `AbortSignal` abort → aborted outcome.
- [x] 2.4 `__tests__/faux-spawn-failure.test.ts`: agent error finish → soft; exhausted provider error → hard (`node-failure-model`).
- [x] 2.5 `__tests__/faux-spawn-prefix.test.ts`: `modelApi: "anthropic-messages"` → `mcp__flows__finish` captured correctly.

## 3. runFlow smoke suites

- [x] 3.1 `__tests__/faux-flow-wiring.test.ts`: two-step flow, content-routing responder, assert `${{result.producer.out}}` reaches the downstream agent.
- [x] 3.2 `__tests__/faux-flow-fork.test.ts`: parallel fan-in (two independent steps + a join `blockedBy` both), assert all complete.

## 3b. Full-integration flow coverage

- [x] 3b.1 Add `runFauxFlow` to the harness: materialize `code`/`code-decision` handlers to temp `.mjs` files (wire `target:`), answer `fork` prompts, surface `onAgentStarted`/`onAgentComplete`.
- [x] 3b.2 `__tests__/faux-flow-integration.test.ts` — kitchen-sink pass path: parallel fan-in + input wiring + code typed outputs + code-decision pass routing + agent-decision verify loop + finalize; robust loop invariants.
- [x] 3b.3 Same file — code-decision FAIL branch exclusivity on a clean terminal-branch flow (taken branch runs, sibling `skipped`).

## 4. Verification & docs

- [x] 4.1 Run `npm run lint`, `npm run typecheck`, `npm test` — all green (298 tests, 0 lint errors, typecheck clean).
- [x] 4.2 Confirm each spec scenario in `faux-model-testing` maps to at least one test case (18 scenarios ↔ 12 tests across 7 suites incl. integration).
- [x] 4.3 Tick the `TODO.md` MUST item "Flow tests / faux model tests".
- [x] 4.4 No `docs/` update warranted — this is internal test infrastructure; the harness is self-documenting via header comments. (Per AGENTS.md, any future docs/ write must be delegated to a subagent.)
