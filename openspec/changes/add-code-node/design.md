## Context

pi-flows' only compute primitive is `spawnAgent()` — every node that does work runs an LLM session. Control-flow steps (`fork`, `conditional`, `agent-decision`, `agent-loop-decision`, `flow-ref`) route but don't compute. Deterministic pipelines (the InvoiceBot goal flow: NAV validation, canonical extraction, reconciliation) therefore have to fake deterministic steps with single-tool agents — expensive, non-deterministic, and wrong for code that is already deterministic.

The result fabric is already type-agnostic: downstream steps read `results[stepId]` with `typedOutputs` merged in (`flow-execution.ts:980`). An agent fills that map from `finish()` params; a code node can fill it from a `return`. The missing pieces are the executor, the authoring guidance (what signature to write), and one downstream fix (`conditional`) so code results are branchable.

Two parser/executor switch statements (`flow-parser-yaml.ts:81`, `flow-execution.ts:428`) are the only closed-set chokepoints; both are extended additively.

## Goals / Non-Goals

**Goals:**
- Run deterministic TypeScript as a first-class DAG node with the same wiring as agents.
- Tell the author *exactly* what handler signature to implement (generated, typed reference).
- Make code results composable in `conditional` branches.
- Strict, predictable runtime contract with clean errors instead of silent garbage.

**Non-Goals:**
- Process isolation (worker/subprocess), hard-kill timeouts, resource/sandbox limits. v1 runs in-process with the same cooperative-abort ceiling as agents.
- Rich per-field output schemas beyond the string contract.
- Promoting registered tools (`flow:register-tool`) to nodes.
- A maintained live-typed `.d.ts` sidecar — the `.ts.default` is a copy-once reference, not a regenerated companion the real file imports.

## Decisions

### D1 — In-process dynamic import, mirroring `spawnAgent` (not a subprocess)
The handler runs in pi's event loop via `await import(target)` (jiti resolves `.ts` from pi's shared module graph), with cooperative `AbortSignal`.

*Why:* `spawnAgent` does **not** fork a process — it runs `createAgentSession` in-process. There is no existing subprocess infrastructure to reuse. Matching the in-process model keeps code nodes consistent with every other node, needs zero new runtime (no `tsx`, no child-runner shim, no stdio protocol), and reuses the already-threaded `cwd`/abort plumbing.

*Alternative considered — subprocess:* would deliver a truly enforceable `timeout` and crash isolation, but requires brand-new infrastructure (spawn `node` + bootstrap a TS loader + JSON stdio protocol + kill-on-timeout + logger streaming). Rejected for v1 as a large scope expansion for a hardening property agents themselves don't have; deferred to a future isolation change.

*Alternative — worker thread:* hard-kill for JS via `terminate()`, lighter than a subprocess, but still new infra plus a TS-loader bootstrap and shared-memory crash hazards. Rejected for the same reason.

*Consequence:* `timeout` is a **soft deadline** (D6).

### D2 — The `.ts.default` reference-template pattern
Generation writes an inert `<id>.ts.default` (tool-owned, always regenerated). The author copies it, drops `.default` to make `<id>.ts`, and implements. The engine runs only the real file.

*Why:* this eliminates the overwrite hazard structurally. Generation can run on *every* save because it only ever clobbers a disposable, tool-owned template — never the author's code, which lives at a different path the generator never writes. The `.ts.default` suffix (not `.default.ts`) makes the template **un-importable by construction**, so it can never be run by accident.

*Alternative — scaffold only when the file is absent:* avoids overwrite but can't keep the template in sync as `inputs`/`outputs` evolve, and risks clobbering on edge cases. The `.ts.default` split is strictly safer.

### D3 — Convention-from-`id` location, with optional `target:` override
Default real file `.pi/flows/handlers/<flow>/<id>.ts`; template `<id>.ts.default`. `target:` overrides for shared/custom paths.

*Why:* every path-based `target` is ambiguous because the file you *name* and the file the engine *runs* differ (template vs real). Deriving both filenames from the unique `id` deletes the naming friction entirely — there is no path to get wrong. A shared handlers dir keeps generated code out of the flow-YAML directory and namespaces by flow. `target:` remains the escape hatch for the rare shared-handler case (which deliberately gets no template — the author owns it).

### D4 — Strict output contract + primitive-only coercion
Return MUST contain exactly the declared outputs (all present, no extras). Strings pass; `number`/`boolean`/`bigint` → `String()`; `object`/`array`/`null` → clean error.

*Why:* strict presence/extras catches contract violations at the boundary instead of letting `undefined` or a stray key flow downstream. Coercing primitives is least-surprise (every template engine renders `true`→`"true"`); rejecting objects blocks the classic `[object Object]` footgun and forces deliberate `JSON.stringify`. This keeps the generated `Output` interface (all `string`) honest while staying ergonomic for the common case.

### D5 — `conditional` resolves typed outputs
`check: <stepId>.<key>` now resolves any typed-output key from the merged map, falling back to `fullOutput` only when the key is absent.

*Why:* code nodes' entire value is typed return data; without this, `conditional` (which only knew `artifacts|summary|files|status`) couldn't branch on them. The fix is small, benefits agents too, and is backward-compatible: the only behavior change is that a `check` field matching a real typed-output key now resolves to that key instead of falling back to `fullOutput` — the more specific, intended meaning.

### D6 — `timeout` is an optional soft deadline
When set: on expiry, abort `ctx.signal` + `status:error` → `on_error`. When omitted: run to completion.

*Why:* in-process code can't be hard-killed (D1). A soft deadline is honest about that ceiling — cooperating handlers stop; CPU-bound code may run on (the same limit agents have). Making it opt-in avoids imposing a deadline on legitimately long deterministic work.

### D7 — Generation decoupled from `flow_write`, triggered on its success
Generation runs on `flow_write` success (operating on persisted YAML) and via `/flows:generate <name>`. Drift between a node's YAML and an existing real handler surfaces as a non-fatal warning via textual `interface` comparison.

*Why:* `flow_write` is transactional (validate-then-persist; nothing written on failure), so hanging generation off its success — against the last-saved, known-good YAML — is robust and idempotent. A human-facing command covers hand-edited flows. Drift detection is *textual* because TS types are erased and `flow_write` is static; it's an early signal, with runtime shape validation (D4) as the hard backstop.

### D8 — `files` not tracked for code nodes
`files = ""`. Paths a downstream step needs are exposed as declared typed outputs.

*Why:* `files` is post-run, human-facing introspection ("what did this node touch"); it doesn't drive flow logic. Explicit wiring (a declared output holding a path) covers the in-flow need. `summary`, by contrast, *is* needed — it's how the main session introspects results before reading them — so it's settable via `ctx.setSummary` with an auto fallback.

## Risks / Trade-offs

- **No isolation / hard-kill (D1, D6)** → a hung or crashing handler can stall pi. *Mitigation:* documented ceiling identical to agents; cooperative abort; isolation deferred to a dedicated future change.
- **Drift detection is textual and best-effort (D7)** → inlined/renamed types evade the static warning. *Mitigation:* runtime shape validation (D4) always catches real mismatches; the warning is explicitly an early signal, not a guarantee.
- **`conditional` resolution change (D5)** → a `check` field that previously fell back to `fullOutput` but coincidentally matches a typed-output key now resolves differently. *Mitigation:* typed-output is the more specific intent; standard fields are unaffected; documented in the proposal's backward-compatibility note.
- **Convention couples handler location to `id`/flow name (D3)** → renaming a node or flow orphans the handler file. *Mitigation:* `target:` override for stability-sensitive cases; regeneration recreates the template at the new path.
- **`.ts.default` clutter (D2)** → a `.ts.default` sits beside every convention handler. *Mitigation:* tool-owned, predictable, gitignorable; clearly inert by suffix.

## Migration Plan

Strictly additive; no migration of existing flows required.
1. Add `CodeStep` to the `FlowStep` union and `CodeNodeContext`/`CodeNodeHandler<I,O>` to exports.
2. Parser: `parseCodeStep` + validation rules; register `case "code"`.
3. Executor: `execute-code-step` module; register `case "code"` in `executeStep`; extend `executeConditionalStep` for typed-output resolution.
4. Generation: `flow-generate` module (scaffold + drift); call from `flow_write` success path; register `/flows:generate`.
5. Tests for each requirement scenario; docs/agent-docs updates delegated per AGENTS.md.

*Rollback:* remove the `case "code"` arms, the generation hook, and the command; the conditional widening is independently safe to keep or revert.

## Open Questions

- Should `.ts.default` templates be auto-added to a `.gitignore` under `.pi/flows/handlers/`, or left for the user to manage?
- Exact wording/format of the auto-generated `summary` fallback (key list vs compact value preview).
- Whether `CodeNodeHandler<I,O>` is worth exporting in v1 or whether the inline `Input`/`Output` interfaces in the scaffold suffice.
