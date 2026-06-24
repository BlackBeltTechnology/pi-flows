## 1. Types & exports

- [x] 1.1 Add `CodeStep` to the `FlowStep` union in `types.ts` (id, optional target, inputs, outputs, blockedBy, on_complete, on_error, timeout)
- [x] 1.2 Add `CodeNodeContext` (`{ signal, cwd, logger, setSummary, flowName, stepId, task }`) and a `CodeNodeHandler<I,O>` helper type to `types.ts`
- [x] 1.3 Export `CodeNodeContext` (and `CodeNodeHandler`) from the package entrypoint

## 2. Parser & validation (flow-parser-yaml.ts)

- [x] 2.1 Write tests for `parseCodeStep`: parses type/target/inputs/outputs/blockedBy/on_complete/on_error/timeout
- [x] 2.2 Implement `parseCodeStep` and register `case "code"` in the `parseStep` switch
- [x] 2.3 Write tests for validation rules (outputs optional; output names unique + valid JS identifiers; input names valid JS identifiers; id filesystem-safe; routing refs exist)
- [x] 2.4 Implement those validation rules in flow-validate so `flow_write` rejects invalid code nodes

## 3. Code-node executor (new execute-code-step module)

- [x] 3.1 Write tests: handler default export invoked with `(input, ctx)`; declared inputs passed as strings; unresolved input → ""
- [x] 3.2 Resolve inputs via existing `expandTemplateVariables`; dynamic-import the resolved handler file and await its default export (in-process, mirrors spawnAgent)
- [x] 3.3 Build `CodeNodeContext` (signal from options, cwd = project root, logger → onAssistantText, setSummary, flowName, stepId, task)
- [x] 3.4 Write tests: strict output contract (all declared present, no extras) + coercion (string passthrough; number/boolean/bigint→String(); object/array/null → soft failure)
- [x] 3.5 Implement return validation + coercion; map success into AgentResult (status complete, typedOutputs, summary via setSummary/auto-fallback, files="", artifacts="", fullOutput=JSON.stringify(outputs))
- [x] 3.6 Write tests: optional `timeout` soft deadline aborts ctx.signal + soft failure; omitted timeout runs to completion
- [x] 3.7 Implement the soft-timeout race; on expiry abort signal and produce a soft failure
- [x] 3.8 Write tests: missing handler file → soft failure with copy-the-template message
- [x] 3.9 Implement missing-handler detection with the guidance message
- [ ] 3.10 Wire failure routing per node-failure-model: plain throw / contract / coercion / missing / timeout → SOFT; `FlowHardError` → HARD (consume the model's outcome type)

## 4. Dispatch & conditional fix (flow-execution.ts)

- [x] 4.1 Register `case "code": executeCodeStep(...)` in the `executeStep` switch
- [x] 4.2 Write tests: code node fires onAgentStarted/onAgentComplete/onAssistantText (name=id) with a `kind:"code"` discriminator
- [x] 4.3 Emit those lifecycle events for code nodes
- [x] 4.4 Write tests for `executeConditionalStep`: `check: <id>.<typedOutput>` resolves from the merged result map; standard fields still work; fallback to fullOutput only when key absent
- [x] 4.5 Extend `executeConditionalStep` to resolve any typed-output key from the merged result map

## 5. Handler generation (new flow-generate module)

- [ ] 5.1 Write tests: `.ts.default` scaffold reflects declared Input/Output interfaces + default-export stub returning empty outputs
- [ ] 5.2 Implement scaffold generation for convention nodes at `.pi/flows/handlers/<flow>/<id>.ts.default`; resolve convention path from flow + id
- [ ] 5.3 Write tests: regeneration always rewrites `.ts.default`, never touches the real `.ts`; custom `target:` nodes get NO template
- [ ] 5.4 Implement regeneration policy (always rewrite template; skip template for custom-target nodes)
- [ ] 5.5 Write tests for drift detection: textual Input/Output interface-block compare vs YAML → non-fatal warning; silent skip when blocks absent
- [ ] 5.6 Implement drift detection emitting a non-fatal warning diagnostic

## 6. Generation triggers

- [ ] 6.1 Invoke generation from `flow-write.ts` on successful write (operating on the persisted YAML)
- [ ] 6.2 Register a `/flows:generate <name>` slash command that regenerates a saved flow's code-node templates
- [ ] 6.3 Write a test that flow_write success produces/refreshes the expected `.ts.default` files

## 7. Integration & verification

- [ ] 7.1 End-to-end test: a flow with a code node wires `${{result.<id>.<output>}}` into a downstream agent step
- [ ] 7.2 End-to-end test: missing handler routes on_error; implemented handler succeeds
- [ ] 7.3 Run `npm run lint`, `npm run typecheck`, `npm test`; fix fallout

## 8. Documentation

- [ ] 8.1 Delegate docs updates to a subagent: `docs/flows.md` (code step type), `docs/flow-authoring.md` (handler contract + generation), `docs/public-api.md` (CodeNodeContext)
- [ ] 8.2 Delegate the caveman mirror to a subagent: `agent-docs/flows.md`, `agent-docs/flow-authoring.md`, `agent-docs/public-api.md`
- [ ] 8.3 Add a CHANGELOG.md entry for the `code` node + `/flows:generate`
