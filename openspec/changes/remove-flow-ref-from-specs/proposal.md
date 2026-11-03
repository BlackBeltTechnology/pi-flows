# Proposal: remove-flow-ref-from-specs

## Why

Sub-flows (the `flow-ref` step) were removed from pi-flows. The parser rejects `type: flow-ref`, `NodeKind` has no `flow-ref` value, and there is no executor. Three main specs still require it (`decision-routing`, `flow-wiring`, `node-kind`), so the specs contradict the code, and new proposals copied the stale step list. An end-to-end test pass found the mismatch when it tried to test sub-flows.

## What Changes

- `decision-routing`: the canonical step-type set is `agent`, `agent-decision`, `code`, `code-decision`, `fork`. `type: flow-ref` is an unknown type.
- `node-kind`: `NodeKind` values are `agent`, `fork`, `agent-decision`, `code`, `code-decision`.
- `flow-wiring`: the "flow-ref result propagation is covered" requirement is removed.
- No code change: the code already matches.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `decision-routing`: step-type set without `flow-ref`.
- `node-kind`: `NodeKind` without `flow-ref`.
- `flow-wiring`: sub-flow result propagation requirement removed.

## Impact

- Specs only. Pending proposals that list `flow-ref` (`node-when-guard`, `map-step`) are corrected in the same pass.
