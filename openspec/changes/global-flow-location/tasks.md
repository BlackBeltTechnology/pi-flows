# Tasks

Every group starts with a failing test derived from the spec.

## 1. Discovery tier

- [ ] 1.1 Failing tests (temp dirs): user flow and agent discovered; missing user dir silent; precedence project > user > package > built-in for flows and agents; `PI_CODING_AGENT_DIR` respected through the root passed by `index.ts`
- [ ] 1.2 Implement `userRoot` in `discoverAll`; pass `join(getAgentDir(), "flows")` from `extensions/flow-engine/index.ts`

## 2. Source labels

- [ ] 2.1 Failing tests: `classifySource` returns `project | user | package | built-in`; `flow_agents list` and `/flows` show the label
- [ ] 2.2 Implement shared `classifySource`; replace `classifyAgentSource`; label in `flow-context/index.ts`

## 3. Execution context

- [ ] 3.1 Failing faux flow test (`runFauxFlow`): a user flow with a code step loads its handler from the user dir; `ctx.cwd` is the project; result file under the project's `.pi/flows/results/`
- [ ] 3.2 Fix any path derived from the project flows dir instead of the flow's own directory

## 4. Authoring scope

- [ ] 4.1 Failing tests: `flow_write` / `flow_agents write` with `scope: "user"` write under the user root and re-discover; default `project`; invalid scope rejected with nothing written
- [ ] 4.2 Implement `scope` in both tools and their descriptions

## 5. Delete

- [ ] 5.1 Failing tests: deleting a user flow removes its user bundle dir and the confirmation names the path; package/built-in refused with the source named
- [ ] 5.2 Implement in `flow-context/index.ts`

## 6. Docs and gates

- [ ] 6.1 Subagent: `docs/flow-authoring.md` discovery table + override priority, authoring `scope`; tip: user flows keep run state under `ctx.cwd`
- [ ] 6.2 `README.md` (user flows line), `CHANGELOG.md`
- [ ] 6.3 `npm run lint && npm run typecheck && npm test`
