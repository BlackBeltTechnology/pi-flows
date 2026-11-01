# Tasks

Prerequisite: `resolver-agnostic-model-refs` is implemented (settings helper, `pickDecisionAgent`, session-model fallback). Every group starts with a failing test derived from the spec.

## 1. Parser and validator

- [x] 1.1 Failing tests: `decider` (list and object form) on flow and steps; `state` on `agent-decision`/`fork`; branch `{ to, means }` normalises to `branches` + `branchMeans`; string form unchanged
- [x] 1.2 Implement in `flow-parser-yaml.ts` and step types
- [x] 1.3 Failing tests: unknown entry error, `trust` enum, `min_confidence` range, warning for branches without `means` in classifier chains
- [x] 1.4 Implement in the flow validator; `flow_write` check that `provider/model` is a known classifier model

## 2. Chain, question and trust (pure)

- [x] 2.1 Failing tests for `resolveDecider` precedence (step → flow → `flows.decider` → `[agent]`) and field-by-field trust resolution
- [x] 2.2 Failing tests for `buildQuestion`: criteria from `means` / labels / fork options, instructions, default and declared state, fork "Other" state
- [x] 2.3 Failing tests for `isTrusted`: calibrated, confidence, auto with and without calibration record
- [x] 2.4 Implement `decider/chain.ts` resolution, `question.ts`, `trust.ts`

## 3. Chain execution

- [x] 3.1 Failing tests with fake entries: first trusted valid label routes; untrusted → shadow and continue; invalid label → failed attempt; exhausted → `{ ok: false, attempts }`; abort stops the chain; 15 s timeout
- [x] 3.2 Implement `decide()`

## 4. Entry adapters

- [x] 4.1 Failing tests for consumer id sanitising, `predict()` request shape (fail-open, cwd, project trust, llmCaller), `ok: false` → failed attempt, no-config → `no-backend` with no network (fake `predict`)
- [x] 4.2 Implement `decider/system-one.ts` with lazy import of `@blackbelt-technology/pi-system-one`; add dependency `^0.11.0`
- [x] 4.3 Failing tests for pi-ai entry: classifier lookup, missing credential reason names provider, answer normalisation, privacy gate (`allowOffMachine: false` + hosted → `off-machine`, no request; loopback → allowed; no config → no gate)
- [x] 4.4 Implement `decider/pi-ai.ts`
- [x] 4.5 Failing tests for `llm-caller.ts`: one completion (no agent session), role resolved with session fallback, answers parsed, `isLocal` rule
- [x] 4.6 Implement `decider/llm-caller.ts`

## 5. Wire into the engine

- [x] 5.1 Failing faux-model flow tests (`runFauxFlow`): default chain unchanged; classifier routes without spawning an agent; classifier low confidence → agent decides; agent without branch fails the `agent-decision` step (no first-branch route); autonomous fork exhausted → step fails; interactive "Other" exhausted → user asked again
- [x] 5.2 Refactor `spawnForkDecisionAgent` and `executeAgentDecisionStep` to call `decide()`; the `agent` entry uses `pickDecisionAgent()`; remove both first-branch fallbacks

## 6. Event and TUI

- [x] 6.1 Failing tests: `flow:decision` payload (attempts, routedBy, `agreed` on shadow attempts), no state or task text, persisted as `flow_decision`; `flow:auto-decision` still emitted
- [x] 6.2 Implement observer hook, `flow-tui.ts` emit and decision line (entry + confidence), `flow-persist.ts` mapping

## 7. Verification and docs

- [ ] 7.1 (left: needs a live pi session with the dashboard's System One config) Manual spike: a `system-one` decision against the dashboard config on this machine; confirm consumer `pi-flows:<flow>:<step>` appears in the dashboard's System One settings; record backend, latency, mode, confidence vs. the agent path
- [x] 7.2 Subagent: update `docs/flows.md`, `docs/flow-authoring.md`, `docs/events-api.md` (decider chain, trust, `means`, `state`, `flow:decision`, consumer-id rename caveat, with/without dashboard setups)
- [x] 7.3 `CHANGELOG.md`: new feature, new dependency, behaviour change (no first-branch fallback)
- [x] 7.4 `npm run lint && npm run typecheck && npm test`
