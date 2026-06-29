## 1. Slim typed result contract (foundation)

- [x] 1.1 Write failing tests: a step output (object/array/number/boolean) is stored under `outputs` with its real type (not stringified)
- [x] 1.2 Introduce the result shape `{ status, summary, fullOutput, outputs: Record<string, unknown> }` in the engine types
- [x] 1.3 Remove `artifacts` and `files` from the result contract, the `finish` tool schema, and the `${{result.X.artifacts}}`/`${{result.X.files}}` template forms; keep `status`/`summary`/`fullOutput`
- [x] 1.4 Stop `String()`-coercing typed outputs (store typed); update all result writers/readers and the affected existing tests; make 1.1 pass
- [x] 1.5 Write failing tests + implement typed delivery to code inputs (Option A): a whole-value `${{result.X.name}}` input arrives typed; an embedded reference arrives as a JIT string; `CodeNodeContext` input type → `Record<string, unknown>`

## 2. JIT serialization at the text boundary

- [x] 2.1 Write failing tests: `${{result.x.obj}}` interpolates to compact JSON; a string output interpolates verbatim
- [x] 2.2 Update template expansion to serialize non-string values with compact JSON at interpolation time; pass strings through
- [x] 2.3 Apply the same boundary serialization where outputs are assembled into an agent prompt/task; make 2.1 pass

## 3. Structured code-node returns

- [x] 3.1 Write failing tests: a handler returning an object output succeeds; a missing/extra declared key still soft-fails
- [x] 3.2 Remove the `object`/`array`/`null` → soft-failure coercion; keep the exact-declared-keys check
- [x] 3.3 Update the code-node return-handling path and `CodeNodeContext` typings; make 3.1 pass

## 4. Non-string agent outputs

- [x] 4.1 Write failing tests: an agent declaring a number output and calling `finish` stores it typed; a type violation triggers the finish-retry loop
- [x] 4.2 Allow declared agent outputs to carry a non-string type: schema validates the string form (incl. numeric/boolean patterns), engine coerces to the declared type on store

## 5. Remove `file://` injection; read just-in-time

- [x] 5.1 Write failing tests: a `file://`-prefixed input is NOT resolved/injected; a declared `*_path` output reaches a consumer as a plain path
- [x] 5.2 Remove the `file://` resolver and verbatim-injection path from input wiring (incl. the sentinel/`replaceSentinels` machinery)
- [x] 5.3 `flow_write`/validation hint: a `*_path`/`*_file` input wired into an agent that lacks the `read` tool is flagged (warning) in `validateFlowContent` (`wiring-validation.test.ts`)
- [x] 5.4 Updated docs (`docs/` + `agent-docs/` via subagent), `skills/manage-flows/SKILL.md`, README, and CHANGELOG to the typed-IO model: typed outputs + JIT serialization, whole-value typed delivery, structured code returns, typed agent outputs, pass-a-path + read-via-tool pattern, typed flow inputs, and the `flow_results runs` seam

## 6. Typed flow input

- [x] 6.1 Write failing tests: a flow with an `inputs:` schema parses; a run started with a structured inputs object exposes `${{flow.input.*}}` and typed handler values; missing `required` input fails start
- [x] 6.2 Add `inputs:` schema parsing + validation to `FlowConfig`
- [x] 6.3 Accept a structured `inputs` object at run start (`flow:run`, run API); validate against the schema; single-`task` default preserved
- [x] 6.4 Wire `${{flow.input.<name>}}` expansion and typed delivery to code handlers

## 7. Run-state exposure (read-only seam)

- [x] 7.1 Tests: `projectRuns` derives per-node pending/running/finished + run liveness from the persisted event stream; total on malformed input (`run-state-projection.test.ts`)
- [x] 7.2 Live + historical per-node state is sourced from the already-persisted flow-event stream (`flow_started.steps` → pending; `agent_started` → running; `agent_complete` → finished + result status/summary; `flow_complete` → not-live). `projectRuns` in flow-persist.ts.
- [x] 7.3 Read-only seam: `flow_results action:"runs"` lists runs + details a run's per-node state; merges produced `outputs` from the completed-run JSON; strictly read-only (no mutate/write-back path).

## 8. Verification

- [x] 8.1 Run the full suite (lint + typecheck + test) green — typecheck clean, lint 0 errors, 312 tests pass
- [x] 8.2 Confirm legacy flows still run: string-only outputs and single-`task` start behave unchanged (green suite incl. faux-flow integration)
