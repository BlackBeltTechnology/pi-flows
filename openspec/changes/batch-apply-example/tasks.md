# Tasks

Prerequisites: `multi-route-decisions` and `fix-authoring-validator` implemented. Every group starts with a failing test derived from the spec. Start from the local copy in `.pi/flows/` (git-ignored).

## 1. Pure helpers

- [ ] 1.1 Failing tests (`batch-lib`): gate detection from `package.json` scripts; `.pi/batch.json` parsing and defaults; manual-task detection; dependency parsing and cycle refusal; question extraction from hand-offs
- [ ] 1.2 Implement in `examples/flows/batch/apply/batch-lib.mjs`

## 2. Flow and handlers

- [ ] 2.1 Failing faux-flow tests (`runFauxFlow`, temp git repo with two fake changes): two changes → two applier agents, no idle agents; dependency wave order; manual-only open task → done; missing gates config → refuses to start naming `.pi/batch.json`; e2e skipped when not configured
- [ ] 2.2 Failing faux-flow tests: blocked applier with a question → operator fork shown, answer passed to the re-apply; autonomous mode → no prompt, questions in the report; conflict resolved with outcome `resolved` → merge continues; resume keeps finished changes
- [ ] 2.3 Port handlers from the local copy: config freeze in `load-plan`, `assignments` array in `plan-wave`, `collect-wave` over `items`, configurable gates/e2e/worktree setup/restore paths, no invoice-bot text
- [ ] 2.4 Write `flow.yaml`: `plan-wave` as a `multi: true` code-decision returning one `apply` route with per-change items (`for_each: dynamic`), the optional gates as two-branch decisions, and the `ask-operator` fork

## 3. Agents and skill

- [ ] 3.1 Failing test: shipped agents validate (no reserved names, no `access:`)
- [ ] 3.2 Port the four agents (`outcome` output, config-driven gate text); write `examples/skills/batch-apply/SKILL.md`; add `examples/` to `package.json` `files` (not `pi.skills`)

## 4. Examples lane

- [ ] 4.0a Failing tests: discovery never registers anything under `examples/`; `/flows:examples` lists `batch-apply` with its description; `install` (default user scope) copies flow bundle, agents and skill to `<agentDir>/flows/...` and `<agentDir>/skills/...`, then re-discovers so `/batch:apply` exists; `--scope project` targets `.pi/`; existing files are not overwritten without `--force`
- [ ] 4.0b Implement `/flows:examples` (list, install) and `examples/flows/batch/apply/example.json`

## 5. Docs

- [ ] 5.1 Subagent: `docs/examples/batch-apply.md` (walkthrough as reference example, with the mermaid pipeline), pointer in `docs/flows.md` and `README.md`
- [ ] 5.2 `CHANGELOG.md`

## 6. Verification

- [ ] 6.1 Manual (operator): install the example (`/flows:examples install batch-apply`), run it on this repo with two small changes in a live pi session; answer one question; then delete the old local `.pi/` copy
- [ ] 6.2 `npm run lint && npm run typecheck && npm test`
