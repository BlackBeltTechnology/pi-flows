# Tasks

Order per AGENTS.md: each group first writes its FAILING test from the spec scenarios, confirms it fails, then implements.

## 1. Frontmatter: single, list, or omitted `model:` (D2)

- [x] 1.1 Add failing tests to `__tests__/agent-parser.test.ts`: `model: @coding` → `model="@coding"`, `modelRefs=["@coding"]`; inline list and block list → ordered `modelRefs`, `model` = first; no `model:` → `model` undefined, `modelRefs=[]`. Verify they fail.
- [x] 1.2 Make `model` optional and add `modelRefs` in `agent-parser.ts` / `types.ts`; update consumers that assumed a string (`agent-card.ts`, `flow_agents list`, observers) to show the used model or `session`. Verify 1.1 passes and `npm run typecheck` is clean.

## 2. Role-agnostic validation (D8, validator half)

- [x] 2.1 Add failing tests in `__tests__/agent-validate-model-ref.test.ts`: `@my-custom-alias` → no model diagnostic; list and omitted → no error; `:extreme` → diagnostic listing valid levels. Verify they fail.
- [x] 2.2 Remove `KNOWN_MODEL_ROLES`, its warning and the stale "Only role aliases" comment; export `VALID_THINKING_LEVELS` from `model-roles.ts`; validate each ref's syntax. Verify 2.1 passes and `grep -rn 'KNOWN_MODEL_ROLES' extensions/` is empty.

## 3. Settings reader (D4)

- [x] 3.1 Add failing tests for `flows-settings.ts`: project overrides global for `flows.modelFallback` and `flows.decisionAgent`; default `modelFallback` is `"session"`; invalid value → default + warning. Verify they fail.
- [x] 3.2 Implement `flows-settings.ts` reusing `edit-flow-config.ts` file lookup. Verify 3.1 passes.

## 4. Resolution chain with fallback (D1, D3, D6)

- [x] 4.1 Add failing tests in `__tests__/model-resolution.test.ts` covering every flow-model-resolution scenario: legacy `@coding` with handler; list skips unresolvable `@fast`; literal miss fails without trying later entries; no resolver → parent model; resolver `probe.error` on `@`-ref → parent model; omitted model → parent model; strict mode fails naming the ref; no session model fails naming the agent; handler error on a literal fails with handler message; thinking = `agent.thinking ?? parent`. Verify they fail.
- [x] 4.2 Implement the D1 chain in `model-roles.ts` returning `{ model, modelId, thinking, fallback? }`; update `@role`-refusal error text to the strict-mode wording. Verify 4.1 passes.
- [x] 4.3 In `index.ts`, track `sessionModel` (session_start, model_select, flow command ctx) and snapshot `parentModel` + settings into `FlowRunOptions` at flow start. Verify with a unit test on the capture.
- [x] 4.4 Add `resolvedModel` to `SpawnOptions`; pass it from `flow-execution.ts` at all three `spawnAgent` sites; `execution.ts` uses it and drops the id re-lookup on that path. Add failing-first tests: handler Model absent from registry → step succeeds; pre-resolved step → registry `find` spy called 0 times. Verify they pass after the change.
- [x] 4.5 Run `doubt-driven-review` on the fallback semantics (typo'd role falls back; cost) and record the outcome here. **Outcome:** accepted — typo'd `@role` falls back by spec; mitigated by the write-time advisory warning (7.2), `modelFallback` on `flow:agent-started` (5.2) and strict `flows.modelFallback: "error"`. Omitted `model:` also fails in strict mode (literal spec reading).

## 5. Fallback reporting (D7)

- [x] 5.1 Add a failing test: no resolver, `model: @fast` → `flow:agent-started` payload has `modelFallback { requested: ["@fast"], used: "prov/parent", reason: "no-resolver" }`. Verify it fails.
- [x] 5.2 Thread `fallback` through `onAgentStarted` extra → event emitter and card. Verify 5.1 passes.

## 6. Decision-agent selection (D5)

- [x] 6.1 Add failing tests for every decision-routing scenario: flow `decision_agent:` used by a fork without `agent:`; `flows.decisionAgent` used by `agent-decision` without `agent:`; step `agent:` wins; built-in fallback; configured agent missing → error naming it and its source; built-in `flow-decision` runs without a resolver on the parent model (faux harness). Verify they fail.
- [x] 6.2 Parser: `decision_agent` on `FlowConfig`; `agent` optional on `agent-decision`. Validator: unknown named decision agent → warning. Verify parser/validator tests pass.
- [x] 6.3 Implement `pickDecisionAgent` and use it in `spawnForkDecisionAgent` and `executeAgentDecisionStep`. Verify 6.1 passes.

## 7. Write-time advisory probe (D8, write half)

- [x] 7.1 Add failing tests in `__tests__/edit-flow-tools.test.ts`: handler errors on `@nope` → `written: true` + warning with the resolver message and fallback note; no handler → no model diagnostic. Verify they fail.
- [x] 7.2 In `flow-agents.ts` write path, emit `model:resolve` per `@`-ref and map errors to warnings. Verify 7.1 passes.

## 8. Docs and skill (D10)

- [x] 8.1 Delegate to a subagent: `docs/events-api.md` documents `model:resolve` as the resolver extension point (probe fields, cooperative early-return, set `model`/`error` before the first `await`, side-effect free) and the `modelFallback` field on `flow:agent-started`; `docs/agents.md` + `docs/flow-authoring.md` document single/list/omitted `model:`, the fallback and `flows.modelFallback`, no role lists, no `@architect`; `docs/flows.md` documents `decision_agent:`, `flows.decisionAgent`, optional `agent:` on `agent-decision`. Verify `grep -rn -E '@(planning|compact|vision|research|architect)' docs/` returns nothing and every new example validates.
- [x] 8.2 Update `skills/manage-flows/SKILL.md` per the MODIFIED skill requirement. Verify the same grep on `skills/` returns nothing.
- [x] 8.3 README.md / AGENTS.md: remove `/roles` and role lists; add the two settings to the settings section. CHANGELOG entry. Verify by grep.

## 9. Integration check

- [x] 9.1 `npm run lint && npm run typecheck && npm test` green.
- [ ] 9.2 Real pi session without pi-agent-dashboard: a flow with `@fast`/`@coding` agents and an autonomous fork runs on the session model and the cards show the fallback; with `flows.modelFallback: "error"` the same flow fails with the documented message. With the dashboard: roles resolve as before and no fallback is reported.

## Workflow follow-up

- Archive the change after review.
