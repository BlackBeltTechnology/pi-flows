## Context

The engine is a hybrid: `blockedBy` forms a DAG among contiguous `agent` steps (parallel waves in `runDagSegment`), while `on_complete`/`on_error` are imperative jumps handled by the segment walker in `runFlow`. `node-failure-model` defines a three-way outcome switch — `success → on_complete`, `soft → on_error`, `hard → halt`. A node with no routing does `segmentIndex++` (fall-through to the next step in file order).

`on_complete` is the success arm. Its only capability beyond `blockedBy` is **forward path-skipping** (jump past steps), which overlaps with `fork`/`*-decision`. It is guarded by neither the validator cycle check (walks `blockedBy` only) nor the `max_iterations` rule (walks decision `branches` only), so `on_complete` + fall-through can form unbounded cross-segment loops. The InvoiceBot audit confirmed 17/18 real `on_complete` uses are pure sequential glue (already reproduced by fall-through) and the one path-skip is a terminal-layout artifact, not a requirement.

## Goals / Non-Goals

**Goals:**
- Remove `on_complete` entirely; collapse routing to `blockedBy` (order) + decisions (select) + `on_error` (recover).
- Make declaring `on_complete` a loud, actionable validation error (migration aid), not a silent ignore.
- Preserve existing behavior for the common case: success falls through to the next step exactly as it does today when no `on_complete` is present.

**Non-Goals:**
- Fixing the implicit fall-through / missing-terminal-concept footgun (separate change).
- Adding a cross-segment loop/visit budget to the walker (separate change).
- Touching `on_error`, decision `branches`, or `blockedBy` semantics.

## Decisions

### D1 — Success falls through; it never routes
`resolveRouteOutcome` stays, but the success arm yields no target. In `runFlow`/`runDagSegment` the route target becomes `outcome === "soft" ? step.on_error : undefined` (hard still halts). Within a DAG segment, the on-success "narrow active steps to reachable-from-target" branch is deleted — on success all `blockedBy`-eligible steps run.
- *Alternative:* keep `on_complete` but guard it (backward-edge validation + loop budget). Rejected — retains the redundant third routing mechanism the user is eliminating.

### D2 — Declaring `on_complete` is a validation error, not a silent ignore
Mirrors the removed-step-type migration errors (`conditional`, `agent-loop-decision`). The parser stops storing `on_complete`; `flow-validate` emits: *"`on_complete` was removed. Order steps with `blockedBy`, or use a `fork`/`code-decision` node to select a forward path."*
- *Alternative:* silently ignore unknown key. Rejected — silent behavior change would strand existing flows with no signal.

### D3 — Reference-ordering graph drops `on_complete` edges
`flow-wiring`'s `${{result.X}}` validity currently accepts `on_complete` chains. The graph-edge builder in `flow-validate` (the `onComplete` edge source) is removed; validity is proven by `blockedBy` ancestry, `on_error` chains, or decision/loop branch chains. Flows that leaned on an `on_complete` chain for ordering must add `blockedBy`.

### D4 — Type removal is the compile-time forcing function
Drop `on_complete?` from `AgentStep` and `CodeStep` in `types.ts`. TypeScript then surfaces every read site (`flow-execution`, `flow-tui`, `flow-preview-overlay`, tests) to update — no reliance on grep completeness.

## Risks / Trade-offs

- **Downstream breakage** → BREAKING and intended. The validation error (D2) gives every affected flow an actionable message. No in-repo flow YAML uses `on_complete`.
- **Lost path-skip ergonomics** → authors who skipped forward with `on_complete` must add a `code-decision`. Acceptable: that is the guarded, cycle-checked mechanism designed for path selection.
- **Fall-through footgun persists** → explicitly out of scope; removing `on_complete` reduces (does not eliminate) the loop surface. Flagged for a follow-up terminal/loop-budget change.

## Migration Plan

1. Ordering-only `on_complete: X` where X is the next step → delete the line (fall-through is identical).
2. Path-skip `on_complete: X` that jumps past steps → replace the deciding node with a `code-decision` whose forward branches route to X vs. the skipped path.
3. Reference relied on an `on_complete` chain for ordering → add `blockedBy: [X]`.
Rollback: revert the change; `on_complete` is re-accepted. No persisted state.

## Open Questions

1. Should the removed-`on_complete` diagnostic be an error (blocks `flow_write`) or a warning for one release? Leaning **error** — consistent with the other removed-feature migrations, and silent flows are worse than a loud stop.
