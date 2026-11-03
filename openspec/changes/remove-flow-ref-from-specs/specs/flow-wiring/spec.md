## REMOVED Requirements

### Requirement: flow-ref result propagation is covered
**Reason**: Sub-flows (`flow-ref` steps) were removed from pi-flows; there is no sub-flow result to propagate.
**Migration**: None. Flows that need shared steps copy them, or run another flow from a code step via the `flow:run` event.
