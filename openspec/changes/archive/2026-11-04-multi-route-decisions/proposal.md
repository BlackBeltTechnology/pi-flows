# Proposal: multi-route-decisions

## Why

A decision picks exactly one target today. Flows therefore cannot:

- **run several lanes chosen at runtime**, e.g. "this repo has a backend and docs, skip the frontend lane";
- **run a lane once per data item**, e.g. one explorer per project when the count comes from a scan. Authors hand-wire fixed slots (`apply-1..4`) and pad unused ones with `none`;

Two earlier proposals added new constructs for this: a `when:` guard on every step (`node-when-guard`) and a `map` step type (`map-step`). Both duplicate what decision nodes already do: choose targets, give untaken branches typed-empty `skipped` results and route failures; an optional step is already a two-branch decision. This change makes a decision's output a **set of routes** instead of one label and replaces both proposals.

## What Changes

- **`multi: true` on `agent-decision` and `code-decision`.** The decision returns zero or more branch labels:
  - agent: `finish({ branches: [...] })`;
  - code: `{ branches: [...] }` or `{ routes: [{ branch, items? }] }`.
  For code-decisions, `branch: x` stays valid and means one route. Flows without `multi: true` are unchanged.
- **Chosen lanes run in parallel.** Every forward target of a multi decision must be an `agent` step in the DAG segment directly after the decision. The engine jumps there and activates every step reachable from a chosen target, using the same reachability rule single routes use today. Everything else in that segment is `skipped`, and choosing nothing skips the whole segment. A step reachable from several lanes, such as a final report, runs once after them.
- **Fan-out runs one agent per item.** A branch declares `for_each: ${{…}}` (a template resolving to an array), or `for_each: dynamic` when a code-decision supplies `items` per route. The chosen target step then runs once per item, with `${{item}}`, `${{item.<field>}}` and `${{item_index}}` (0-based). Steps blocked by it run once after all items and read `${{result.<target>.items}}` (ordered per-item results). `max_items` caps the count (default 50).
- **Failures:**
  - **Instances:** a soft failure doesn't stop the sibling items; afterwards the failed aggregate routes like the target step's own soft failure.
  - **Lanes:** follow today's segment rules.
  - **Item expansion:** a bad `for_each` value or the cap soft-fails the decision.
- **Loops stay single-route.** A multi decision may have a backward branch, but must return it alone. At `max_iterations` it behaves as "nothing chosen".
- **Classifiers** are removed from a multi decision's chain at runtime, and an explicit step-level classifier `decider:` is a validation error.
- **Events:**
  - `flow:decision` adds `labels` and `routes: [{ branch, itemCount? }]`;
  - every per-agent event of an item run carries `itemIndex` and `itemCount`;
  - the TUI shows item cards as `<stepId>[i]`.
- **Optional steps need no new construct.** A two-branch decision (`run: e2e` / `skip: <next>`) already jumps past an optional step of any type. This change also gives every untaken decision branch target a `skipped` result, which forks already did.
- **Supersedes** `map-step` and `node-when-guard` (removed). Forks are unchanged.

## Capabilities

### New Capabilities
- `multi-route-decisions`: `multi: true`, multi-label returns, segment activation, fan-out (`for_each`, `items`, `max_items`), item templates and aggregate results, failure, loop and classifier rules, events.

### Modified Capabilities
- `decision-routing`: a decision resolves one or more labels; unchosen lanes are skipped.
- `code-decision-node`: a multi handler may return `branches` or `routes`.

## Impact

- **Code:**
  - parser and types: `multi`, `for_each`, `max_items`;
  - `runFlow`: multi activation and the skipped-overwrite rule;
  - `runDagSegment`: instances and aggregation;
  - `runDecision`, `decisionAgentContext`, `describeBadFinish` and the decision finish schema (`branches`);
  - the decider chain types and `decide()` (label lists);
  - the code-decision return contract and `flow-generate.ts` scaffold types;
  - `agents/flow-decision.md` and `reserved-outputs.ts` (`branches`);
  - template expansion (`item`, `item_index`, `.items`);
  - a step-scoped validator check and reserved names;
  - `flow-tui.ts` / `agent-dashboard.ts` instance cards;
  - event payloads.
- **Not in scope:**
  - per-item chains of steps;
  - lanes outside the next segment;
  - per-lane failure isolation;
  - forks;
  - resumable runs (flows are not resumable; see `docs/architecture.md`);
  - multi-label classifier questions.
- **Docs:** `docs/flows.md`, `docs/flow-authoring.md`, `docs/events-api.md`, `docs/architecture.md`, `docs/public-api.md`.
- **Behaviour changes called out:**
  - in a multi decision's segment, unchosen steps are overwritten with `skipped`;
  - a multi decision at its loop cap skips the segment instead of falling through;
  - `${{item…}}` becomes a reserved template prefix;
  - untaken decision branch targets get `skipped` results (previously forks only).
- **Used by:** `batch-apply-example`, which must be rewritten on top of this change. `plan-wave` becomes a multi code-decision returning one `apply` route whose items carry the change name and its worktree path; `collect-wave` reads `${{result.apply.items}}`.

## Discipline Skills
`doubt-driven-review` (semantics before implementation), `systematic-debugging` (scheduler changes), `code-simplification`.
