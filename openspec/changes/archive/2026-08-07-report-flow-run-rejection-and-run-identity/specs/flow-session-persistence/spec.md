## MODIFIED Requirements

### Requirement: Persisted flow event record carries the cross-repo contract fields

The `data` recorded with each `flow-event` entry SHALL contain:
- `seq`: a monotonically increasing integer assigned at emit time, used to reproduce live ordering on replay;
- `eventType`: the **dashboard protocol event name** (the mapped name such as `flow_tool_call`, `flow_assistant_text`, `flow_agent_started`), NOT the raw `flow:*` channel name;
- `data`: the exact payload the bridge would have forwarded for that event;
- `flowRunId`: an identifier for the originating flow run.

The `flowRunId` SHALL be minted **once per run by the engine** (`FlowManager.start`) and supplied to the persister; the persister SHALL record the **supplied** id and SHALL NOT self-mint a run id on the `flow:flow-started` channel. This guarantees the `flowRunId` on every persisted record for a run equals the run id carried on that run's live `flow:*` payloads (a single identity across the live and persisted planes). The orphan/reconciliation terminal-record path SHALL continue to inject an **explicit** `flowRunId` (the orphaned run's id, read from disk) independently of any live run id.

Recording the already-mapped `eventType` SHALL allow a consumer to re-forward `{ eventType, data }` verbatim without a second name-mapping table.

#### Scenario: Record uses the mapped protocol event name

- **WHEN** pi-flows persists the event raised as `flow:subagent-tool-call`
- **THEN** the recorded `eventType` SHALL be `flow_tool_call` (the dashboard protocol name)
- **AND** the recorded `data` SHALL equal the payload forwarded on the live path

#### Scenario: Sequence numbers reproduce live ordering

- **WHEN** multiple agents emit events concurrently during a parallel flow
- **THEN** each persisted record SHALL carry a `seq` that strictly increases in emit order
- **AND** a consumer ordering records by `seq` SHALL reproduce the order the live reducer observed

#### Scenario: Persisted id equals the live run id

- **WHEN** a run emits lifecycle events and pi-flows persists them
- **THEN** the `flowRunId` on every persisted record for that run SHALL equal the engine-minted run id carried on the same run's live `flow:*` payloads

#### Scenario: Persister does not self-mint

- **WHEN** the `flow:flow-started` channel is persisted
- **THEN** the persister SHALL record the run id supplied by the engine
- **AND** the persister SHALL NOT generate a new run id of its own
