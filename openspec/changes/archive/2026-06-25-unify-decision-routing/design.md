## Context

The flow engine models steps as a discriminated union on `stepType` (`extensions/flow-engine/types.ts`) and schedules them in `flow-execution.ts`, which splits steps into two classes: **DAG work steps** (`agent`, `code` — run in parallel, route via `on_complete`/`on_error`) and **separator steps** (`fork`, `conditional`, `agent-decision`, `agent-loop-decision`, `flow-ref` — run one at a time, own the routing). `executeCodeStep` already returns `typedOutputs`; `executeAgentDecisionStep` already resolves a returned branch name against a `branches: Record<string,string>` map and errors on an off-map value. The `code` node ships with handler scaffolding via `/flows:generate` and a soft/hard failure model (`node-failure-model`).

The gap: no node lets **code** compute a branch and route N-ways, and the loop variant (`agent-loop-decision`) is a near-duplicate of the decision variant differing only in edge direction. InvoiceBot needs deterministic, replayable, LLM-free routing (`FR-APR-7`, `FR-REC-11`, `FR-APR-14`).

## Goals / Non-Goals

**Goals:**
- A `code-decision` node = `code` node + reserved `branch` output driving a `branches:` map; may also carry data outputs.
- Unify "decision" and "loop" into one routing mechanism: a branch edge may point forward (decide/exit) or backward (loop); `max_iterations` guards cycles.
- Collapse the type set to `agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`.
- Type-safe branch scaffolding (generated `Branch` union) with a runtime hard-fail backstop.
- Validation, dashboard card, and docs for the new model.

**Non-Goals:**
- Option 3 "knob-bag" model (work × branch_by × edges on every node). Rejected for blast radius.
- Changing `fork`'s human-interaction semantics (it stays the human-labeled router).
- Changing `flow-ref` or the `code`/`agent` work-node contracts beyond branch routing.
- Dashboard React implementation (lives in `pi-agent-dashboard`; pi-flows only emits events).
- An "optional output" type — empty string remains the null-object contract.

## Decisions

### D1. `code-decision` = `code` + reserved `branch` output
**Choice:** Reuse `executeCodeStep` unchanged for execution; after typed-output validation, extract a reserved output named `branch` and resolve it against `branches:` exactly as `executeAgentDecisionStep` does today. Other declared outputs flow downstream normally.
**Why over alternatives:** A configurable `branch_output:` field adds surface for no real gain; the reserved name mirrors `agent-decision`'s `finish(branch=)` so the mental model ("who decides" varies, "branch" is constant) holds across families. Reusing the executor avoids a second code-execution path.

### D2. Routing is a capability; loop = backward edge
**Choice:** A `*-decision` node's `branches:` values may target any step. If a target is reachable backward (forms a cycle), it is a loop edge and the node MUST declare `max_iterations`. Loop bookkeeping reuses the existing `loopCounters`/`loopMaxIterations` maps already present in `FlowContext`.
**Why over alternatives:** Keeping a separate `agent-loop-decision`/`code-loop-decision` type duplicates routing logic for a difference that is purely topological. Detecting backward edges from graph structure (rather than a `loop_target` field) makes loop-vs-decide a property of the wiring, not a separate declaration.

### D3. Keep `type:`-named families (Option 2), not full unification
**Choice:** Retain `agent-decision` vs `code-decision` vs `fork` as distinct types whose name encodes the **label source** (LLM / code / human). Drop `agent-loop-decision` and `conditional`.
**Why over alternatives:** The label-source distinction is exactly InvoiceBot's P4 governance axis ("who is allowed to decide"). A discriminated union keeps validation, parsing, and dashboard rendering simple and self-documenting; the knob-bag (Option 3) forces conditionally-required fields and a scheduler rewrite.

### D4. Type-safe branch scaffold + runtime backstop
**Choice:** `/flows:generate` emits `type Branch = "<k1>" | "<k2>" | ...` from `branches:` keys and types the handler return as `Promise<{ branch: Branch; ...outputs }>`. At runtime an off-map `branch` is a **hard** failure (consistent with `agent-decision`), independent of `on_error`.
**Why:** Catches wrong branch names at author time; the runtime check guards hand-edited handlers and drift.

### D5. Skip-empty data-flow contract (documented, unchanged mechanics)
**Choice:** Routing nodes always execute, so their own outputs are always present (loops settle to last-iteration values). Skipped forward siblings receive synthetic `skipped` results; unresolved `${{result.X}}` → `""`. Best practice: wire downstream inputs from guaranteed-run producers (the decision node itself or a common ancestor), or guard on `result.<branch>.status == "skipped"`.
**Why:** Reuses the existing fork skip mechanism; avoids inventing optional-output typing.

### D6. `conditional` removal path
**Choice:** Delete `ConditionalStep` and its `code-node` interop requirement; the canonical replacement is a small `code-decision` handler returning `present`/`absent`. Parser rejects `type: conditional` with a migration hint.
**Why:** `conditional` is a degenerate `code-decision` (emptiness-only); maintaining it duplicates routing for a case the general node covers in three lines.

## Risks / Trade-offs

- **Scheduler complexity: a work node is now also a routing node** → Confine routing to `*-decision` types; `code`/`agent` keep success/error-only routing. `code-decision` runs as a separator step (sequential), reusing the existing separator branch in `runFlow`.
- **Backward-edge detection edge cases (multi-target cycles, diamonds)** → Validator computes reachability; require `max_iterations` whenever any branch target can re-enter the node; reject unbounded cycles at validation, not runtime.
- **Breaking removal of `conditional`/`agent-loop-decision`** → Blast radius verified minimal (no shipped `.yaml` uses them). Parser emits actionable migration errors; CHANGELOG + docs document the rewrite recipe.
- **Reserved `branch` collides with a user's data output named `branch`** → Validator forbids declaring a non-routing output named `branch` on `code-decision`; on plain `code` nodes `branch` stays an ordinary output.
- **Dashboard lag** (card not yet in `pi-agent-dashboard`) → Emit `kind: "code-decision"` on existing `flow:*` events now; dashboard degrades to a generic node card until its companion PR lands.

## Migration Plan

1. Land engine changes behind the new discriminated union; parser accepts the new set and rejects removed types with hints.
2. Update internal/test flows and `agent-docs`/`docs` to the new model in the same change.
3. Rewrite the InvoiceBot spec's `route-approval` (→ `code-decision`) and `partner-known` (→ `code-decision` presence handler) in IB's own repo (out of scope here; noted for the IB team).
4. Rollback: revert is clean since no persisted flow files depend on the removed types.

## Open Questions

- Should the validator additionally warn when a `code-decision` declares no `branch` output at all (likely a mistake) vs treat it as a plain side-effect code node? Leaning: error — `code-decision` without `branch` is malformed.
- Do we want a convenience: allow `branches:` with a single forward target to behave like `on_complete` sugar, or always require ≥2 branches? Leaning: require ≥2 to keep `code` vs `code-decision` distinct.
