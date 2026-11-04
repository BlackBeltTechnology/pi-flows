# Tasks

Every group starts with a failing test derived from the spec. Check each audit item against current code first; if already fixed, tick it with a note.

## 1. Reserved output names

- [ ] 1.1 Failing tests: outputs `status`/`summary`/`files`/`artifacts` rejected; `branch` rejected on decision agents; `outcome` accepted; shipped agents still validate
- [ ] 1.2 Implement in `tools/agent-validate.ts` (and the write-time check in `flow_agents`)

## 2. Fresh discovery per run

- [ ] 2.1 Failing test: edit an agent's output between two runs in one session; the second run uses the edit
- [ ] 2.2 Implement rediscovery at run start (slash command, `flow:run`, `runFlow` API)

## 3. Validator corrections

- [ ] 3.1 Failing tests: `tools: []` valid; `${{flow.input.x}}` valid when declared; inline-list `inputs`/`outputs` parsed; `card.type` warning only when meaningful
- [ ] 3.2 Failing tests: `on_error` on `fork` and `agent-decision` routes soft failures; fork branch key not in `options` rejected; `type: object|array` agent outputs rejected
- [ ] 3.3 Implement in parser, validators and `flow-execution.ts`

## 4. flow_write

- [ ] 4.1 Failing tests: `name`/`namespace` regex enforced, traversal rejected with nothing written; description states the bundle path
- [ ] 4.2 Implement

## 5. Docs and gates

- [ ] 5.1 Subagent: `docs/agents.md` (reserved output names), `docs/flow-authoring.md` (rules above)
- [ ] 5.2 `CHANGELOG.md` (behaviour change: reserved names)
- [ ] 5.3 `npm run lint && npm run typecheck && npm test`
