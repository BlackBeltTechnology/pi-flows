# Implementation Guide — add-code-node

This guide sequences the implementation work across 8 task sections from `tasks.md`, explaining dependencies and verification strategy.

## Overview

The feature is **strictly additive** and follows the execution flow naturally:

1. **Types & exports** — define the data shapes (nothing runs yet)
2. **Parser & validation** — read YAML and validate code nodes
3. **Executor** — implement the runtime (calls handlers, routes errors)
4. **Dispatch & conditional fix** — wire executor into the DAG; extend conditional resolution
5. **Generation** — scaffold `.ts.default` templates and drift detection
6. **Generation triggers** — hook generation into `flow_write` and add `/flows:generate` command
7. **Integration & verification** — end-to-end tests and style/type checks
8. **Documentation** — user-facing docs and agent-docs mirrors

**Critical path:** Tasks 1→2→3→4→7 (all others are enhancements; 5→6→7 is a sub-path). Tasks 2, 4, 5, 7 have testable outcomes per section; implement and verify each before moving forward.

## Task 1: Types & exports (estimated 30 min)

**Goal:** define `CodeStep`, `CodeNodeContext`, and `CodeNodeHandler<I, O>` types, export them from the package.

**Dependencies:** none (purely additive to the type union).

**Verification:**
- [ ] 1.1 `CodeStep` interface added to `types.ts` with all required fields (id, optional target, inputs, outputs, blockedBy, on_complete, on_error, timeout)
- [ ] 1.2 `CodeNodeContext` interface added with signal, cwd, logger, setSummary, flowName, stepId, task
- [ ] 1.3 `CodeNodeHandler<I, O>` helper type added (generic over Input/Output interfaces)
- [ ] 1.4 All three exported from `extensions/index.ts`
- [ ] 1.5 TypeScript compiles: `npm run typecheck`

**Implementation hints:**
- `CodeStep` extends the pattern of `AgentStep` — see `types.ts:76–87` for reference.
- `logger` is `(msg: string) => void`.
- `setSummary` is `(text: string) => void`.
- `CodeNodeHandler<I, O>` is a generic function type: `(input: I, ctx: CodeNodeContext) => Promise<O>`.

---

## Task 2: Parser & validation (estimated 2–3 hours)

**Goal:** read `type: code` from YAML, parse all fields, validate per the spec requirements.

**Dependencies:** Task 1 (types) ✓

**Tests first (write these before implementing):**
- [ ] 2.1 Test `parseCodeStep`: parses type/target/inputs/outputs/blockedBy/on_complete/on_error/timeout correctly from YAML
- [ ] 2.3 Test validation: outputs optional, output names unique + valid JS identifiers, input names valid JS identifiers, id filesystem-safe, routing refs exist

**Implementation:**
- [ ] 2.2 Implement `parseCodeStep(node: any): CodeStep` in `flow-parser-yaml.ts` (mirroring `parseAgentStep` at line 81)
- [ ] Register `case "code": return parseCodeStep(node)` in the step-type switch (line 120)
- [ ] 2.4 Implement validation rules in `flow-validate.ts` (or add to the existing validator). Validation is called from `flow_write`'s path; a validation error prevents persistence.

**Verification:**
- [ ] 2.1, 2.3 Test suite passes: `npm test -- flows.test.ts` (create `__tests__/code-node-parser.test.ts` and `__tests__/code-node-validation.test.ts`)
- [ ] TypeScript compiles: `npm run typecheck`

**Implementation hints:**
- Use `parseAgentStep` (line 81–103) as a template; code node parsing is similar but simpler (no `agent:` field, no `reads:`, different field set).
- Validation rules are in `flow-validate.ts` — add a new section for code-node validation (parallel to agent validation).
- Filesystem-safe `id` means no `/`, `\`, `..`, `:` — suitable for filenames. Regex: `/^[a-zA-Z0-9_.-]+$/` is a safe default.
- JS identifier validation: `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`.

---

## Task 3: Code-node executor (estimated 4–5 hours)

**Goal:** implement `execute-code-step.ts`, the runtime that imports handlers, calls them, validates outputs, and maps results.

**Dependencies:** Task 1 (types) ✓, Task 2 (parser) ✓

**Tests first (write these before implementing):**
- [ ] 3.1 Test: handler default export invoked with `(input, ctx)`, declared inputs passed as strings, unresolved input → `""`
- [ ] 3.3 Test: `CodeNodeContext` built correctly (signal, cwd, logger, setSummary, flowName, stepId, task)
- [ ] 3.4 Test: strict output contract — all declared present, no extras, soft failure diagnostics
- [ ] 3.5 Test: output coercion (string pass-through, number/boolean/bigint→String(), object/array/null→soft failure)
- [ ] 3.6 Test: `timeout` soft deadline aborts signal; omitted timeout runs to completion
- [ ] 3.8 Test: missing handler file → soft failure with copy-the-template message
- [ ] 3.10 Test: error routing (plain throw / contract / coercion / missing / timeout → SOFT; `FlowHardError` → HARD)

**Implementation:**
- [ ] 3.2 Implement handler resolution via `await import(target)` (use pi's jiti loader)
- [ ] 3.3 Build `CodeNodeContext` with signal from `options`, cwd from `options.cwd`, logger via `onAssistantText` callback, setSummary, etc.
- [ ] 3.5 Implement return validation + coercion; map success into `AgentResult` (status complete, typedOutputs, summary, fullOutput=JSON.stringify, files="", artifacts="")
- [ ] 3.7 Implement soft-timeout race (use `Promise.race` with a timeout promise that aborts the signal)
- [ ] 3.9 Implement missing-handler detection with guidance message
- [ ] 3.10 Implement failure routing: catch all soft-eligible errors, route via `on_error` or hard-fail; handle `FlowHardError` separately

**Verification:**
- [ ] 3.1–3.10 Test suite passes: `npm test -- code-node-executor.test.ts`
- [ ] TypeScript compiles: `npm run typecheck`
- [ ] Linter passes: `npm run lint`

**Implementation hints:**
- Start with the simplest case: handler exists, has a default export, returns valid outputs → success.
- Then add soft failures layer by layer (contract, coercion, timeout, missing).
- Use `expandTemplateVariables` (already imported in flow-execution.ts) to expand input templates.
- `onAssistantText` is a callback in the `StepCallbacks` object passed to executors.
- Timeout can use `AbortSignal.timeout(ms)` (Node 17+) or a manual `setTimeout + AbortController` pattern.
- `status` field in return should be `"complete"` on success, `"error"` on soft failure.

---

## Task 4: Dispatch & conditional fix (estimated 2 hours)

**Goal:** wire the executor into `executeStep` and extend `executeConditionalStep` to resolve typed outputs.

**Dependencies:** Task 1 (types) ✓, Task 2 (parser) ✓, Task 3 (executor) ✓

**Tests first:**
- [ ] 4.2 Test: code node fires onAgentStarted/onAgentComplete/onAssistantText (name=id) with `kind:"code"` discriminator
- [ ] 4.4 Test: `executeConditionalStep` resolves `check: <id>.<typedOutput>` from merged result map; standard fields still work; fallback to fullOutput when key absent

**Implementation:**
- [ ] 4.1 Register `case "code": return executeCodeStep(...)` in `executeStep` switch (around line 570 in flow-execution.ts)
- [ ] 4.3 Emit lifecycle events (`onAgentStarted`, `onAgentComplete`, `onAssistantText` during execution, `onAgentError` on failure) with `kind: "code"`
- [ ] 4.5 Extend `executeConditionalStep` (around line 786) to parse `<stepId>.<key>` syntax and resolve the key from `results[stepId]`; fall back to `fullOutput` only when the key is absent

**Verification:**
- [ ] 4.2, 4.4 Test suite passes: `npm test -- flow-dispatch.test.ts` or `npm test -- conditional.test.ts`
- [ ] TypeScript compiles: `npm run typecheck`
- [ ] Linter passes: `npm run lint`

**Implementation hints:**
- Callback event emission mirrors the agent dispatcher (`execution.ts:164–190`).
- `kind: "code"` is a new field in the event payload; add it to the interface if needed.
- Typed-output resolution: parse `check` field for pattern `<stepId>.<key>` using regex like `/^([a-zA-Z0-9_.-]+)\.([a-zA-Z0-9_$]+)$/` and look up `results[stepId][key]`.
- Fallback to `fullOutput` is the existing behavior — only add the typed-output path as a new fallback **before** the standard field path.

---

## Task 5: Handler generation (estimated 3–4 hours)

**Goal:** create `flow-generate.ts` module to scaffold `.ts.default` templates, detect drift, and regenerate on demand.

**Dependencies:** Task 1 (types) ✓, Task 2 (parser) ✓

**Tests first:**
- [ ] 5.1 Test: `.ts.default` scaffold reflects declared Input/Output interfaces + default-export stub returning empty outputs
- [ ] 5.3 Test: regeneration always rewrites `.ts.default`, never touches real `.ts`; custom `target:` nodes get NO template
- [ ] 5.5 Test: drift detection — textual Input/Output interface-block compare vs YAML → non-fatal warning; silent skip when blocks absent

**Implementation:**
- [ ] 5.2 Implement scaffold generation for convention nodes at `.pi/flows/handlers/<flow>/<id>.ts.default`; resolve convention path from flow + id
- [ ] 5.4 Implement regeneration policy (always rewrite template; skip template for custom-target nodes)
- [ ] 5.6 Implement drift detection — extract `interface Input { ... }` and `interface Output { ... }` blocks textually from real handler file; compare key sets to YAML; emit non-fatal warning if mismatch

**Verification:**
- [ ] 5.1, 5.3, 5.5 Test suite passes: `npm test -- code-generate.test.ts`
- [ ] TypeScript compiles: `npm run typecheck`
- [ ] Linter passes: `npm run lint`

**Implementation hints:**
- Scaffold template is a string literal with TypeScript code:
  ```typescript
  import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";
  
  interface Input { /* keys from YAML inputs */ }
  interface Output { /* keys from YAML outputs */ }
  
  export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
    // TODO: implement
    return { /* empty values for each output key */ };
  }
  ```
- Path convention: `.pi/flows/handlers/<flowName>/<nodeId>.ts.default` and `.pi/flows/handlers/<flowName>/<nodeId>.ts` for real file.
- Drift detection regex: `/interface\s+(Input|Output)\s*\{\s*([^}]+)\}/g` to extract blocks, then parse key names.
- Use `fs.writeFileSync` to write `.ts.default`; check `fs.existsSync` for real file before drift detection.
- Emit diagnostics via the validator/logger — non-fatal warnings don't block save.

---

## Task 6: Generation triggers (estimated 1 hour)

**Goal:** hook generation into `flow_write` success path and add `/flows:generate` command.

**Dependencies:** Task 5 (generation) ✓, Task 2 (parser) ✓

**Implementation:**
- [ ] 6.1 Import and call generation from `flow_write.ts` on successful write; pass the persisted YAML
- [ ] 6.2 Register a slash command `/flows:generate <name>` that loads a saved flow and regenerates its code-node templates
- [ ] 6.3 Write a test that flow_write success produces the expected `.ts.default` files

**Verification:**
- [ ] 6.3 Test suite passes: test that `flow_write` with a code node produces `.ts.default`
- [ ] TypeScript compiles: `npm run typecheck`
- [ ] `/flows:generate flow-name` command appears in pi and functions correctly

**Implementation hints:**
- Hook generation into `flow_write.ts` after the `fs.writeFileSync(flowYamlPath, ...)` line (after persistence succeeds).
- Slash command: register via `pi.slashCommands.register` in the extension's `onLoad` hook (in `extensions/index.ts` or the workspace module).
- Slash command implementation: parse `<name>`, load the flow from `.pi/flows/flows/<name>.yaml`, extract code nodes, call generation for each.

---

## Task 7: Integration & verification (estimated 2 hours)

**Goal:** end-to-end tests, lint, typecheck, all tests passing.

**Dependencies:** all previous tasks ✓

**Tests:**
- [ ] 7.1 End-to-end test: flow with code node wires `${{result.<id>.<output>}}` into downstream agent step
- [ ] 7.2 End-to-end test: missing handler routes `on_error`; implemented handler succeeds

**Verification:**
- [ ] 7.3 `npm run lint` passes
- [ ] 7.3 `npm run typecheck` passes
- [ ] 7.3 `npm test` (all suites) pass

**Implementation hints:**
- E2E tests use a fixture flow YAML with a code node and a downstream agent. The code node returns typed outputs that the agent reads.
- Missing handler test: delete the real handler file, run flow, verify `on_error` path is taken.
- Implemented handler test: create a simple handler that returns the declared outputs, run flow, verify result is available downstream.

---

## Task 8: Documentation

**Goal:** user-facing docs, agent-docs mirrors, CHANGELOG entry.

**Dependencies:** all implementation tasks ✓ (8.1–8.3 are documentation; separate subagent calls per AGENTS.md)

**Delegation:**
- [ ] 8.1 Subagent writes: `docs/flows.md` (code step type), `docs/flow-authoring.md` (handler contract + generation), `docs/public-api.md` (CodeNodeContext)
- [ ] 8.2 Subagent writes: `agent-docs/flows.md`, `agent-docs/flow-authoring.md`, `agent-docs/public-api.md` (caveman style)
- [ ] 8.3 Add CHANGELOG.md entry for the `code` node + `/flows:generate` command

**Orchestration:**
- Main agent: confirm all implementation tasks pass, then dispatch 8.1 and 8.2 to subagents with clear handoff prompts.
- Subagents: read the finished proposal, design, spec, DASHBOARD-DELEGATION-BRIEF for context; write prose docs or caveman mirrors per AGENTS.md rules.

---

## Rollback / Reversal

If a task fails and you need to revert:

1. **After task 1:** remove `CodeStep`, `CodeNodeContext`, `CodeNodeHandler<I, O>` from types and exports.
2. **After task 2:** remove the `case "code"` parser arm and validation rules.
3. **After task 3:** remove the executor module and the import.
4. **After task 4:** remove the `case "code"` in dispatch and revert the conditional change.
5. **After task 5–6:** remove the generation module and the triggers.
6. **After task 8:** revert docs and CHANGELOG additions.

The conditional typed-output resolution (task 4.5) is independently safe to keep.

---

## Troubleshooting

**Parser fails to recognize `type: code`**: ensure the switch case is registered in `parseStep` (flow-parser-yaml.ts:120).

**Handler import fails**: check that the resolved path is correct; log the path before `await import()`.

**Timeout not working**: verify the `AbortSignal` is passed and the handler checks it (`ctx.signal.aborted`).

**Drift detection never fires**: check that `fs.existsSync(realHandlerPath)` is true and the interface blocks are named exactly `interface Input { ... }` and `interface Output { ... }`.

**Code node card doesn't render**: ensure the `kind: "code"` event field is populated correctly in task 4; the dashboard needs this discriminator (see DASHBOARD-DELEGATION-BRIEF.md).
