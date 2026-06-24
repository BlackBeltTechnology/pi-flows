## 1. End-to-end wiring tests (primary deliverable)

- [x] 1.1 Test `expandTemplateVariables` for all 10 variable forms (`task`, `input.NAME`, `result.STEP`, `.summary`, `.status`, `.artifacts`, `.files`, `.<typedOutput>`, `loop.iteration`, `loop.max`)
- [x] 1.2 Test typed-output extraction → `${{result.STEP.name}}` resolution for both agent and code nodes
- [x] 1.3 Test input-block resolution (`inputs: {x: "${{result.A.out}}"}` → `${{input.x}}`)
- [x] 1.4 Test flow-ref result propagation (sub-flow step result referenceable downstream)
- [x] 1.5 Test edge cases: empty value, standard-field resolution, loop counters at boundaries

## 2. Fail-loud reference validation (flow-validate)

- [x] 2.1 Write tests: unknown step ID rejected; unknown typed-output field rejected; standard fields always pass
- [x] 2.2 Implement load-time scan of all template references; resolve known steps and their declared outputs (agent/code `outputs` + standard fields); emit a hard `Diagnostic` for unknowns
- [x] 2.3 Ensure diagnostic messages name the offending reference, the unknown token, and the referencing step

## 3. Ordering validation (blockedBy + routing reachability)

- [x] 3.1 Write tests: reference without ordering rejected; reference satisfied by transitive `blockedBy` passes; reference satisfied by `on_complete`/`on_error` routing passes
- [x] 3.2 Implement a reachability computation over `blockedBy` (transitive) AND routing edges (`on_complete`/`on_error` chains)
- [x] 3.3 Emit a hard `Diagnostic` when a referenced step is not reachable-before; name the missing dependency. Do NOT auto-add the edge.

## 4. Loop counter consistency

- [x] 4.1 Write tests: first body pass observes `1`; body and decision step agree on iteration N within a pass
- [x] 4.2 Fix the increment timing so the loop body executing pass N sees `iteration == N` (not N-1)
- [x] 4.3 Confirm `docs/flows.md` / `agent-docs/flows.md` state 1-based (already documented); adjust if wording drifts

## 5. Remove the dead `reads` field

- [x] 5.1 Remove `reads?: string[]` from `AgentStep` in `types.ts`
- [x] 5.2 Remove the `reads` parsing block in `flow-parser-yaml.ts`
- [x] 5.3 Grep for any remaining `reads` references; confirm none consumed

## 6. Folded-in hardening (D5)

- [x] 6.1 Add the missing finish-retry test: agent failing declared-output schema is re-prompted up to `MAX_FINISH_RETRIES`, then soft-fails
- [x] 6.2 Fix cosmetic `code-node` spec wording: success sets `files` to `[]` (`ResultFile[]`), not `""`

## 7. Docs & validation

- [x] 7.1 Update `docs/flows.md` / `agent-docs/flows.md` (delegate to subagent per AGENTS.md): document the new fail-loud reference + ordering validation
- [x] 7.2 Run `npm run lint && npm run typecheck && npm test` — all green
- [x] 7.3 `openspec validate harden-flow-wiring --strict` passes
