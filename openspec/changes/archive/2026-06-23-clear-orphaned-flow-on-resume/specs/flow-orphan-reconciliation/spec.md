## ADDED Requirements

### Requirement: An interrupted flow run is detected on session start

On `session_start`, pi-flows SHALL scan the active session's persisted entries (`sessionManager.getEntries()`) for `customType: "flow-event"` records, group them by `flowRunId`, and identify the most recent flow run (the run with the highest maximum `seq`). A flow run SHALL be considered ORPHANED when it has no persisted record whose `eventType` is `flow_complete`. Detection SHALL be read-only and best-effort: a failure to read entries SHALL NOT throw into session startup.

#### Scenario: Run without a terminal record is orphaned

- **WHEN** the session is resumed and the latest flow run's persisted records contain `flow_started`/`flow_agent_started`/… but no `flow_complete`
- **THEN** pi-flows SHALL classify that run as orphaned

#### Scenario: Run with a terminal record is not orphaned

- **WHEN** the latest flow run's persisted records include a `flow_complete` record
- **THEN** pi-flows SHALL NOT classify that run as orphaned and SHALL emit no reconciliation event

#### Scenario: No flow-event entries

- **WHEN** the session contains no `flow-event` entries
- **THEN** detection SHALL be a no-op with no reconciliation event emitted

### Requirement: An orphaned flow run is reconciled to a terminal state

When an orphaned flow run is detected, pi-flows SHALL drive it to a terminal state by emitting the `flow:complete` channel live AND persisting a `flow_complete` record tagged with the ORPHANED run's `flowRunId`. The emitted/persisted `FlowResult` SHALL carry a terminal status and a human-readable summary identifying the cause (parent-session close on the resume path; no-live-run abort on the abort path). The live emit clears connected dashboard clients immediately; the persisted record makes the next cold resume idempotent.

#### Scenario: Reconciliation emits and persists a terminal event for the orphaned run

- **WHEN** pi-flows reconciles an orphaned run with `flowRunId` `R`
- **THEN** pi-flows SHALL emit the `flow:complete` channel with a `FlowResult` whose status is terminal
- **AND** pi-flows SHALL persist a `flow_complete` `flow-event` record whose `flowRunId` equals `R`

#### Scenario: Reconciliation is inert without a consumer

- **WHEN** no dashboard replay branch consumes the synthesized `flow_complete`
- **THEN** the emitted event and persisted record SHALL have no other side effect and SHALL NOT break session resume

### Requirement: Reconciliation is idempotent

pi-flows SHALL NOT emit more than one terminal reconciliation for the same flow run. The presence of any `flow_complete` record for a run's `flowRunId` — from clean completion, a prior resume reconciliation, or an abort reconciliation — SHALL be the sole idempotency guard; a run carrying such a record SHALL be skipped on every subsequent scan.

#### Scenario: Second resume does not re-terminate a reconciled run

- **WHEN** a run was reconciled on a previous resume (a synthesized `flow_complete` now exists for its `flowRunId`)
- **AND** the session is resumed again
- **THEN** pi-flows SHALL NOT emit a second reconciliation event for that run

### Requirement: Synthesized terminal records replay after the run's mid-run events

Because `FlowEventPersister.seq` restarts at `0` on each new session, pi-flows SHALL seed the resumed persister's `seq` counter past the maximum `seq` found among persisted `flow-event` records (`maxSeq + 1`) so that every record written after resume — the reconciliation `flow_complete` included — carries a `seq` greater than the orphaned run's mid-run events. This guarantees a consumer ordering by `seq` applies the terminal event last.

#### Scenario: Reconciliation record sorts last

- **WHEN** the orphaned run's mid-run records occupy `seq` values up to `N`
- **THEN** the synthesized `flow_complete` record SHALL carry a `seq` strictly greater than `N`
- **AND** a consumer ordering records by `seq` SHALL apply the terminal event after the run's mid-run timeline

### Requirement: Abort with no live flow reconciles instead of no-op

The `flow:abort` handler SHALL clear a stuck card when no flow is live. When `flowManager.isRunning` is true the handler SHALL abort the live flow as before; when it is false the handler SHALL reconcile the latest orphaned run (per the reconciliation requirement) rather than returning silently.

#### Scenario: Abort on a resumed session clears the card

- **WHEN** `flow:abort` is received and `flowManager.isRunning` is false because the session was resumed
- **THEN** pi-flows SHALL emit a terminal reconciliation event for the latest non-terminal run
- **AND** the handler SHALL NOT be a silent no-op

#### Scenario: Abort on a live flow still aborts the live flow

- **WHEN** `flow:abort` is received and `flowManager.isRunning` is true
- **THEN** pi-flows SHALL call `flowManager.abort()` and SHALL NOT invoke orphan reconciliation
