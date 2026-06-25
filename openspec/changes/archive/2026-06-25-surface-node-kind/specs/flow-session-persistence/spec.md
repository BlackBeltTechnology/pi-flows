## ADDED Requirements

### Requirement: Persisted records carry nodeKind so replay reconstructs card type

The `flow-event` records persisted for `flow_agent_started` / `flow_agent_complete` SHALL carry `nodeKind` inside their `data` payload (it rides along because `data` is the exact emitted payload; no `FlowEventRecord` interface change is required). Re-forwarding the persisted records SHALL reconstruct each card's TYPE — not only its timeline — so a replayed run renders the same code / agent / decision cards the live run did. Code-node program logs SHALL replay as logs under a code card, because the card's `nodeKind` is reconstructed from the started record.

#### Scenario: Replay rebuilds card type

- **WHEN** the persisted `flow-event` records for a completed run that included a `code` node are re-forwarded in `seq` order to the dashboard's `reduceFlowEvent`
- **THEN** the rebuilt card for that node SHALL have `nodeKind: "code"`, identical to the live run

#### Scenario: Code logs replay as logs, not LLM output

- **WHEN** a replayed `code` node's `flow_assistant_text` records are re-forwarded after its `flow_agent_started` record carrying `nodeKind: "code"`
- **THEN** those text entries SHALL render as program logs under the reconstructed code card, distinguishable from an agent's assistant text
