# Tasks

- [x] 1. **Parser change.** In `extensions/flow-engine/flow-parser-yaml.ts`:
  - [x] 1a. Replace `const stepType = explicitType || inferStepType(raw)` with logic that throws when `raw.type` is missing/empty: error names the step `id` and lists valid types (`agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`).
  - [x] 1b. Delete the now-unused `inferStepType` function.
  - [x] 1c. Confirm the `conditional` / `agent-loop-decision` migration errors still fire on an explicit `type:` value (they no longer depend on inference of `check:` / `loop_target:`).
- [x] 2. **Rejection test.** Add a parser test: a step with `id` + `agent:` but no `type:` is rejected with an error naming the step id and the valid types.
- [x] 3. **Fix inference-reliant tests** by adding explicit `type:` lines:
  - [x] 3a. `__tests__/bundle-layout.test.ts` (`MIN_FLOW`, line ~18).
  - [x] 3b. `__tests__/code-decision.test.ts` — replaced the now-invalid "inferred conditional (check: shorthand)" test with the missing-type rejection test (others already declared type).
  - [x] 3c. `__tests__/code-node-validation.test.ts` — no change needed; all steps already declare `type:`.
  - [x] 3d. `__tests__/edit-flow-tools.test.ts` (~141, 212).
- [x] 4. Run `npm test` — all suites green (281 passed).
- [x] 5. Run `npm run typecheck` and `npm run lint` — clean (0 errors; warnings pre-existing).
- [x] 6. **Spec.** MODIFIED "Canonical step-type set" requirement present in `specs/decision-routing/spec.md` (validates `--strict`).
- [x] 7. **Docs (delegate to subagent).** Rewrite the "type is optional — infers…" content in `docs/flow-authoring.md` (~355–377) and `docs/flows.md` rows to state `type:` is required on every step.
- [x] 8. **Skill.** Update `.pi/skills/edit-flow/SKILL.md:185` to require explicit `type:` on every step (drop "usually inferred").
- [x] 9. Noted the breaking change in `CHANGELOG.md` and bumped version 0.2.4 → 0.3.0.
