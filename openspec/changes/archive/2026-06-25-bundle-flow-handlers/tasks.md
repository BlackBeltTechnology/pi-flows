## 1. Discovery: bundled layout

- [x] 1.1 Write failing tests: discovery loads `.pi/flows/flows/<ns>/<name>/flow.yaml`, registers `/<ns>:<name>`, sets `FlowConfig.source` to the `flow.yaml` path; a flat `<name>.yaml` is NOT discovered
- [x] 1.2 Update `discovery.ts` to scan for `<ns>/<name>/flow.yaml`, derive the command id from the directory structure (slash→colon), and set `source`
- [x] 1.3 Confirm tests pass

## 2. Source-relative handler resolution

- [x] 2.1 Write failing tests: generator and executor produce the SAME path for a namespaced flow — `dirname(flow.source)/<id>.ts` (+ `.ts.default`); empty `flow.source` with a convention handler fails loudly
- [x] 2.2 Update `execute-code-step.ts` to resolve `join(dirname(flowSource), "<id>.ts")` (added a `flowSource` param alongside `flowName`; drop the `cwd`+`flowName` reconstruction); add the empty-source guard
- [x] 2.3 Update `flow-generate.ts` `handlersDirFor` to use `dirname(yamlPath)` (drop the `..` math)
- [x] 2.4 Keep `target:` resolution against `cwd` unchanged
- [x] 2.5 Confirm tests pass (regression: generator path === executor path)

## 3. flow_write + delete

- [x] 3.1 Tests updated: `flow_write` writes `<ns>/<name>/flow.yaml` (edit-flow-tools.test.ts); generate/executor co-locate in the flow dir
- [x] 3.2 Update `tools/flow-write.ts` to write `.pi/flows/flows/<namespace>/<name>/flow.yaml`
- [x] 3.3 Update `deleteFlowFiles` (flow-context) to `rmSync(dirname(flowPath), { recursive: true })` (handlers included)
- [x] 3.4 Confirm tests pass

## 4. Clean break

- [x] 4.1 Discovery reads only `<dir>/flow.yaml`; loose `<name>.yaml` ignored. Executor resolves only `dirname(flowSource)/<id>.ts` (the old `.pi/flows/handlers/` tree is never consulted)
- [x] 4.2 Test: a flat `<name>.yaml` is not discovered (bundle-layout.test.ts)

## 5. Verification & docs

- [x] 5.1 Gate green: typecheck clean, lint 0 errors, 280/280 tests pass
- [x] 5.2 Update `skills/edit-flow/SKILL.md` (Code handlers + Write locations): bundled layout, handler co-located in the flow dir, `flow.yaml`, delete-removes-dir
- [x] 5.2b Update README.md flow/handler layout references to the bundled directory layout
- [x] 5.3 Update `docs/flow-authoring.md` + `docs/architecture.md` (delegate to subagent): bundled layout + source-relative resolution. (agent-docs removed from the doc policy)
- [x] 5.4 Add a **BREAKING** CHANGELOG entry with the one-line migration (`mv <name>.yaml <name>/flow.yaml`; move handlers into the dir; repoint `flow-ref` globs)
