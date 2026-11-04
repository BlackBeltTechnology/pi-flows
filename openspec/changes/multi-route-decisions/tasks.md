# Tasks

Every group: write the failing faux e2e/unit tests from the spec scenarios first, confirm they fail, then implement.

## 1. Parse and validate
- [ ] 1.1 Failing tests for every validation scenario:
  - `multi: true` with one branch;
  - targets outside the next segment / non-agent targets;
  - overlapping lanes and a fan-out target reachable from another lane;
  - two labels to one target;
  - reserved `branches`/`routes`/`items`;
  - `for_each` / `max_items` (1–1000, integer) placement;
  - `${{item…}}` scope (task, inputs, agent body);
  - `.items` accepted, and declared outputs of fan-out targets rejected;
  - step-level classifier `decider:`;
  - multi decision with no following segment.
- [ ] 1.2 Parser and types: `multi`, branch `for_each` (template or `dynamic`), `max_items`.
- [ ] 1.3 Validator: the rules above, with a step-scoped template scan that also covers `for_each`; the `decision-routing` branch-count rule relaxed for `multi`.

## 2. Decision outputs
- [ ] 2.1 Failing tests:
  - agent `finish({ branches })`, and `finish({ branch })` rejected on multi;
  - code `{ branch | branches | routes }` with the check order from D9;
  - non-multi `branches` key as a declared data output;
  - classifier filtering, with `flow:decision.chain`.
- [ ] 2.2 Decision finish schema, `describeBadFinish` and `decisionAgentContext` for `branches`; `agents/flow-decision.md`; reserve `branches` for decision agents.
- [ ] 2.3 Decider types carry `labels[]` (`DecisionAnswer`, `DecisionOutcome`, `DecisionAttempt`, `decide()` label checks, empty list valid); `runDecision` / chain filtering; `executeCodeDecisionStep` multi contract; `flow-generate.ts` scaffold type.

## 3. Activation
- [ ] 3.1 Failing tests:
  - two of three lanes plus a report that runs once;
  - choosing nothing;
  - a stale pass-1 result overwritten on pass 2;
  - loop alone, loop plus lane (soft failure, counter not incremented), cap reached;
  - a jumped-over separator gets `skipped`.
- [ ] 3.2 `runFlow`: union activation, the `overwriteSkipped` mode flag, empty selection, cap behaviour for multi, `skipped` for jumped-over steps.

## 4. Fan-out
- [ ] 4.1 Failing tests:
  - one explorer per project with a merge step;
  - `routes` items with `${{item.field}}`;
  - out-of-order completion, then ordered `items`;
  - empty list; over the cap; not an array; `""` treated as `[]`;
  - items given for a non-fan-out branch;
  - one item soft-fails (then `on_error`); an instance hard-fails (siblings aborted);
  - a segment cut short mid-fan-out; `max_concurrent` respected;
  - `lastResult` is the aggregate.
- [ ] 4.2 `runDagSegment` instances, per-instance template context (`item`, `item.<field>`, `item_index`, agent body), aggregation (top-level `items`), failure routing.
- [ ] 4.3 Template expansion and `resolveCodeInput` for `.items`.

## 5. Events and display
- [ ] 5.1 Failing tests:
  - `flow:decision` `labels`/`routes`/`routeError`, and `label` absent with `routedBy` present;
  - `itemIndex`/`itemCount` on every per-agent event and on `onExtensionUIRequest`;
  - TUI cards `<stepId>[i]`.
- [ ] 5.2 Observer/event payloads, `flow-tui.ts`, `agent-dashboard.ts`, persisted `flow_decision`.

## 6. Docs and release notes
- [ ] 6.1 `docs/flows.md`, `docs/flow-authoring.md`, `docs/events-api.md`, `docs/architecture.md`, `docs/public-api.md` (delegated); CHANGELOG with the behaviour changes called out in the proposal.
- [ ] 6.2 Live check: a GLM run of a fan-out flow and a lanes flow through the local build (RPC driver).
- [ ] 6.3 Companion issue in pi-agent-dashboard: key cards on `stepId` + `itemIndex`.
