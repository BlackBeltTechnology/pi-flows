## Why

`on_complete` is an unconditional forward-jump routing edge layered on top of the DAG. It **duplicates** what `blockedBy` (ordering) and `fork`/`*-decision` (conditional path selection) already express, and — unlike decision branches — it is covered by **neither** cycle guard: the validator's cycle check walks only `blockedBy`, and the `max_iterations` backward-edge rule walks only decision `branches`. Combined with implicit fall-through, `on_complete` chains can form unbounded cross-segment loops that run until the user aborts (observed: a `recover → assemble → report → recover` cycle). Removing it collapses the routing model to one coherent story: **`blockedBy` orders, decisions select, `on_error` recovers.**

## What Changes

- **BREAKING: the `on_complete` step field is removed** from `agent` and `code` steps. A step that declares `on_complete` is now a validation **error** with an actionable migration message.
- Success no longer routes: a node that succeeds **falls through to the next step in file order** (as it already does when no `on_complete` is declared). Path-skipping is expressed with a `fork`/`code-decision` node; ordering with `blockedBy`.
- `on_error` (soft-failure routing) and decision `branches` are **unchanged** — they remain the only explicit routing edges.
- Template-reference ordering (`${{result.X}}`) validity drops `on_complete` from its accepted chains: a reference is valid via `blockedBy` ancestry, an `on_error` routing chain, or a decision/loop branch chain.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `node-failure-model`: the success arm no longer routes to `on_complete`; success falls through to the next step. `on_error` and hard-halt semantics are unchanged.
- `flow-wiring`: `${{result.X}}` ordering validity no longer accepts `on_complete` chains (blockedBy / on_error / branch chains only).
- `decision-routing`: the single-branch diagnostic no longer advises `on_complete`; it advises `blockedBy` ordering.
- `code-node`: code-node validation no longer references `on_complete`; declaring it is rejected.

## Impact

- **Code:** `types.ts` (drop `on_complete` from `AgentStep`/`CodeStep`), `flow-parser-yaml.ts` (stop parsing it), `flow-execution.ts` (success arm → fall-through; only `on_error` routes), `flow-validate.ts` (reject `on_complete` with a migration error; drop it from the reference-ordering graph), `flow-tui.ts` + `flow-preview-overlay.ts` (drop display), `failure.ts` (comment).
- **Tests:** update `code-node-parser`, `failure-model`, `code-node-validation`, `wiring-validation`, `flow-started-route-fields`, `code-node-e2e` to the fall-through model.
- **Specs:** delta MODIFIED for the four capabilities above.
- **Docs:** `flows.md`, `flow-authoring.md`, `public-api.md`, and the `manage-flows` skill lose `on_complete`; add the migration note (use `blockedBy` / decisions).
- **No bundled flow YAMLs use `on_complete`** — nothing to migrate in-repo. Downstream flows that use it must migrate (BREAKING).
- **Out of scope:** the implicit fall-through / missing-terminal footgun and a cross-segment loop budget — separate follow-up; this change only removes `on_complete`.
