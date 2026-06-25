## Why

Flow routing today is fragmented across five overlapping step types (`fork`, `conditional`, `agent-decision`, `agent-loop-decision`, plus success/error routing on `agent`/`code`), and there is **no deterministic, code-driven branch** at all. The closest options force either an LLM `agent-decision` (probabilistic, prompt-injectable) or the emptiness-only `conditional` (2-way, no comparison/enum/score logic). The InvoiceBot functional spec makes this gap concrete: its dominant decision — rule-based approval routing (`FR-APR-7`: "compiled TypeScript evaluator … no LLM judgment in the decision itself") and tiered reconciliation (`FR-REC-11`: score ≥90 auto / 60–89 review / <60 exception) — must be deterministic, yet is currently shoe-horned into an LLM `agent-decision` node held together by a prompt instruction. A first-class **code-decision** node closes this, and unifying routing as a *capability* (where a loop is simply a branch with a backward edge) collapses the type sprawl.

## What Changes

- **NEW `code-decision` node**: the existing `code` node plus a reserved `branch` output that drives a `branches:` map. May also return data outputs (e.g. `branch` + `approvers`). Deterministic, LLM-free, replayable.
- **Routing becomes a capability; loop = backward edge**: `agent-decision` and `code-decision` branch targets may point **backward** (a loop) or **forward** (a decision/exit). `max_iterations` is required only when a branch forms a cycle. A routing node always executes, so its own outputs are always populated (last-iteration wins for loops).
- **Type-safe branch scaffolding**: `/flows:generate` emits a TypeScript `Branch` union from the `branches:` keys; an off-map branch is a compile-time error, with a runtime hard-fail backstop.
- **BREAKING — remove `agent-loop-decision`**: folded into `agent-decision` (backward edge + `max_iterations`).
- **BREAKING — remove `conditional`**: emptiness checks become a 3-line `code-decision` handler. The `code-node` "Conditional resolves typed outputs" interop requirement is retargeted to `code-decision`.
- **Final step-type set**: `agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`.
- **Validation, dashboard, docs**: `flow_validate` learns branch-completeness, unreachable-branch, and "backward edge ⇒ `max_iterations` required" checks; dashboard renders a `code-decision` card via `flow:*` events carrying `kind`; docs updated in `flows.md` + `flow-authoring.md` (+ `agent-docs/` mirror).

Migration blast radius is minimal: no shipped `.yaml` flow files use `conditional`, `agent-loop-decision`, or `loop_target` — only engine code, tests, one dashboard preview file, and docs.

## Capabilities

### New Capabilities
- `decision-routing`: The generalized routing model — branch-label → edge resolution, forward edges (decide/exit) and backward edges (loop) with `max_iterations` cycle guard, the canonical step-type set, skipped-forward-sibling semantics (synthetic `skipped` results, empty-string null-object contract), and removal of `conditional` / `agent-loop-decision`. Covers `agent-decision` gaining backward edges and the `fork` (human-labeled) node's place in the model.
- `code-decision-node`: The `code-decision` step type — reserved `branch` output, branch + data outputs, type-safe generated `Branch` union, off-map-branch hard-fail backstop, handler scaffold generation, and `code-decision`-specific validation.

### Modified Capabilities
- `code-node`: The "Conditional resolves typed outputs" requirement is removed/retargeted, since `conditional` is deleted and `code-decision` becomes the consumer of code-node typed outputs for branching.
- `dashboard-event-emission`: Lifecycle/`kind` events extended so the dashboard can render a distinct `code-decision` node card.

## Impact

- **Code**: `extensions/flow-engine/types.ts` (discriminated union — add `CodeDecisionStep`, drop `ConditionalStep`/`AgentLoopDecisionStep`, extend `AgentDecisionStep` with backward-edge fields), `flow-parser-yaml.ts` (inference + parse), `flow-execution.ts` (routing/scheduler: backward-edge loop counters, branch resolution, separator handling), `execute-code-step.ts` (reserved `branch` extraction), `flow-generate.ts` (type-safe scaffold), `tools/flow-validate.ts` (new checks), `guard.ts`, `flow-persist.ts`, `flow-dashboard/flow-preview-overlay.ts`.
- **Tests**: `__tests__/flow-dispatch.test.ts` and new suites for `code-decision` + backward-edge loops.
- **Docs**: `docs/flows.md`, `docs/flow-authoring.md`, and `agent-docs/` mirrors.
- **Downstream**: `pi-agent-dashboard` needs a `code-decision` card (consumes existing `flow:*` event stream; no pi-flows-side coupling).
- **Breaking**: any flow using `conditional` or `agent-loop-decision` must migrate (none shipped in-repo).
