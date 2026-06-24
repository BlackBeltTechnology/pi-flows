# Add Generic Code Node

## Why

pi-flows has exactly one compute primitive: `spawnAgent()` (`extensions/flow-engine/execution.ts:164`). Every node that *does work* runs an LLM session. The remaining step types (`fork`, `conditional`, `agent-decision`, `agent-loop-decision`, `flow-ref` — `extensions/flow-engine/types.ts:62`) are control flow. There is **no way to run deterministic code as a DAG node.**

This is a real gap for deterministic pipelines (the motivating case is InvoiceBot's "single, immutable deterministic goal flow" — NAV validation, canonical extraction, reconciliation). Today you'd fake deterministic steps with an LLM agent whose only job is to call one tool: expensive, non-deterministic, and absurd for code that is already deterministic.

The wiring fabric is **already generic** — downstream steps read `results[stepId]` (typed outputs merged in at `flow-execution.ts:980`) and don't care how the map was filled. An agent fills it from `finish()` params; a code node can fill it from a `return` value. We only lack the executor — plus the authoring ergonomics to tell the user exactly what handler signature to wire into.

## What changes

Add a `code` step type that runs a target `.ts` module with a typed interface and merges its return value into the result context, exactly like an agent's typed outputs. Scope is end-to-end: executor, handler-file generation, authoring guidance, and the one downstream fix (`conditional`) that makes code nodes composable.

**Depends on `node-failure-model`.** Code-node failure routing (soft vs hard, `on_error`-as-soft-switch, `FlowHardError`) is defined by the `node-failure-model` change and consumed here; this change does not redefine those semantics.

### 1. The `code` step type and handler contract

```yaml
  - id: validate-nav
    type: code
    inputs:
      invoice: "${{result.extract.canonical}}"
    outputs:
      - name: valid
      - name: nav_record
    blockedBy: [extract]
    on_complete: approve
    on_error: park
```

Handler module contract (default export):

```typescript
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

interface Input  { invoice: string }
interface Output { valid: string; nav_record: string }

export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
  // ... deterministic work ...
  return { valid: "true", nav_record: "..." };
}
```

- **Entry point:** the module's **default export**, an `async` function `(input, ctx)`.
- **`input`:** every declared input, template-expanded to a string, keyed by name. Unresolved templates resolve to `""` (consistent with agent input expansion). Always present as a string — never `undefined`.
- **`ctx: CodeNodeContext`** = `{ signal, cwd, logger, setSummary, flowName, stepId, task }`:
  - `signal: AbortSignal` — flow abort; handler should respect it.
  - `cwd: string` — project root (the `.pi`-containing dir, already threaded as `FlowRunOptions.cwd`).
  - `logger(msg: string)` — streams to the running step's card (routed through the existing `onAssistantText` channel).
  - `setSummary(text: string)` — sets the step summary for main-session/dashboard introspection.
  - `flowName`, `stepId`, `task` — identity + the flow's overall task text.
- **Return (STRICT contract):** the returned object MUST contain exactly the declared `outputs` — every declared key present, **no undeclared extra keys**. Violations → SOFT failure.
- **Value coercion:** `string` passes through; `number`/`boolean`/`bigint` → `String()`; `object`/`array`/`null` value → SOFT failure naming the key (author must `JSON.stringify` intentionally). Coerced values populate `typedOutputs`.
- **Failure signalling (per `node-failure-model`):** a plain `throw` (and every soft-eligible failure above — contract violation, coercion error, missing handler, timeout) is a SOFT failure: it routes `on_error` when set, or hard-fails the flow when `on_error` is unset. `throw new FlowHardError(msg)` (exported from the package) is an unconditional HARD failure that stops the flow regardless of `on_error`.
- **`outputs` is optional:** a side-effect-only node may declare none and return `{}`.

### 2. Execution

- **In-process dynamic import**, mirroring `spawnAgent`: pi's shared **jiti** module graph (`docs/architecture.md:183`) resolves the target `.ts` via `await import(...)` — no `tsx`, no subprocess, no new dependency. The handler runs in pi's event loop with cooperative `AbortSignal` (same isolation ceiling as agents).
- **`timeout` (optional):** when set, a soft deadline — on expiry, abort `ctx.signal` and produce a SOFT failure (routes `on_error`, or hard-fails if unset — per `node-failure-model`). When omitted, the handler runs to completion. Hard-kill / resource limits require process isolation, which is out of scope (see below).
- **Result mapping** into `AgentResult`: `status` = complete|error · `typedOutputs` = coerced return · `summary` = `setSummary` value or auto-generated fallback · `fullOutput` = `JSON.stringify(outputs)` · `files` = `""` (not tracked for code nodes) · `artifacts` = `""`.
- **Missing handler at run time:** if the real handler file does not exist, a SOFT failure (routes `on_error`, or hard-fails if unset — per `node-failure-model`) with a message telling the author to copy the `.ts.default` template, drop `.default`, and implement the default export.
- **Events:** code nodes fire the same `onAgentStarted` / `onAgentComplete` / `onAssistantText` step callbacks (name = node id) with a `kind: "code"` discriminator. Visualization is the dashboard's concern.

### 3. Handler location and generation

- **Convention over configuration:** a code node's handler is located from its `id`. Default real file: `.pi/flows/handlers/<flow>/<id>.ts`; reference template: `.pi/flows/handlers/<flow>/<id>.ts.default`. An optional `target:` field overrides the path for the rare shared/custom case.
- **`<id>.ts.default` is an inert, tool-owned reference template** (the `.ts.default` suffix means it is never importable/runnable). It contains a **full runnable scaffold**: the `CodeNodeContext` import, typed `Input`/`Output` interfaces derived from the node's `inputs`/`outputs`, and a default-export function with a `// TODO` body returning empty outputs. The author **copies it, renames to drop `.default`, and implements the body.** The engine runs the real (non-`.default`) file.
- **Generation runs automatically on every `flow_write` success** (decoupled from validation: `flow_write` only persists on success, so generation operates on the last-saved, known-good YAML). Also exposed as a human-facing `/flows:generate <name>` slash command for hand-edited flows. No standalone agent tool.
- **Regeneration policy:** the `.ts.default` is always rewritten (even when the real file exists) to stay in sync with the node's `inputs`/`outputs`. It never touches the real file. When the real file exists, a **drift check** compares the YAML-derived `Input`/`Output` key sets against the `interface Input`/`interface Output` blocks textually extracted from the real handler; a mismatch emits a **non-fatal warning** diagnostic. If those blocks can't be found (author inlined/renamed types), the warning is skipped silently and runtime shape validation is the backstop.
- **Custom `target:` nodes get NO template** — the author owns the file entirely; runtime shape validation is their safety net.

### 4. `conditional` typed-output resolution (the composability fix)

Today `executeConditionalStep` (`flow-execution.ts:786`) only resolves `artifacts | summary | files | status`; any other `check` field silently falls back to `fullOutput`, so `conditional` cannot branch on a named typed output. This change extends it: `check: <stepId>.<key>` resolves **any** typed-output key from the merged result map, falling back to `fullOutput` only when the key is genuinely absent. This benefits agent steps too and is what makes code nodes composable in branches.

### 5. Validation (in `flow_write` / flow-validate)

- `outputs` optional.
- Output names unique and valid JS identifiers (they become interface keys and `${{}}` references).
- Input names valid JS identifiers.
- `id` must be filesystem-safe (it becomes the handler filename).
- `blockedBy` / `on_complete` / `on_error` reference existing step ids (already enforced for all steps).

## Impact

- **Affected specs:** new `code-node` capability (step type, handler contract, execution, result mapping, generation + `.ts.default` scaffolding + drift detection, `/flows:generate` command, conditional typed-output resolution, validation).
- **Affected code:**
  - `types.ts` — add `CodeStep` to the `FlowStep` union; add `CodeNodeContext` (exported from the package entrypoint alongside a `CodeNodeHandler<I,O>` helper).
  - `flow-parser-yaml.ts` — parse `type: code` (inputs/outputs/target/blockedBy/on_complete/on_error/timeout) + the validation rules above.
  - `flow-execution.ts` — `executeStep` switch `case "code"`; extend `executeConditionalStep` for typed-output resolution.
  - new `execute-code-step` module — resolve inputs, dynamic-import + invoke the default export, validate + coerce the return, map into `AgentResult`, soft-timeout, route on success/error.
  - new `flow-generate` module — `.ts.default` scaffold generation + drift detection; invoked from `flow_write`'s success path and the `/flows:generate` command.
  - `flow-write.ts` — call generation on successful write.
  - slash-command registration for `/flows:generate`.
- **Backward compatibility:** strictly additive — a new `stepType` plus a backward-compatible widening of `conditional` field resolution (existing flows unaffected; previously-fullOutput-fallback fields that happen to match a typed-output key now resolve to that key — acceptable since typed outputs are the more specific intent).
- **Out of scope:**
  - **Process isolation** (worker-thread / subprocess) and resource limits / hard-kill timeouts — v1 runs in-process with the same cooperative-abort ceiling as agents; revisit when untrusted code is a concern.
  - **Rich per-field output schemas** beyond the string contract (runtime presence + primitive coercion is in scope; structured type validation is not).
  - **Promoting registered tools** (`flow:register-tool`) to nodes — different mechanism, separate decision.
  - **Full per-node `.d.ts` type regeneration** as a maintained sidecar — the `.ts.default` scaffold is a copy-once reference, not a live-typed sidecar.
