## ADDED Requirements

### Requirement: Live flow lifecycle events carry a run identity

Every live `flow:*` lifecycle event in the run-scoped set SHALL carry a run identity that is stable for the duration of one flow run and distinct across runs. The run-scoped set is the eleven channels `flow:flow-started`, `flow:agent-started`, `flow:agent-complete`, `flow:assistant-text`, `flow:thinking-text`, `flow:subagent-tool-call`, `flow:subagent-tool-result`, `flow:auto-decision`, `flow:loop-iteration`, `flow:agent-error`, and `flow:complete`. The run id SHALL be additive on the payload; existing consumers that do not read it SHALL be unaffected. The identity SHALL be present in headless/RPC sessions, not only under a TUI.

`flow:prompt-request` is OUT OF SCOPE: its only emit site is the pre-run task prompt, which fires before a run exists (no identity to stamp); real in-run prompts travel a different channel. `flow:summary-started` / `flow:summary-ready` are also OUT OF SCOPE (emitted by a separate sub-extension, post-run). A follow-up change may extend the run id to them.

#### Scenario: All run-scoped events of one run share the id

- **WHEN** a single flow run emits its lifecycle events
- **THEN** every one of the eleven run-scoped `flow:*` payloads for that run SHALL carry the same run id

#### Scenario: Two runs are distinguishable

- **WHEN** two flow runs execute (sequentially or concurrently)
- **THEN** their run-scoped events SHALL carry different run ids, so a consumer can attribute each event to its run

#### Scenario: Identity present headless

- **WHEN** a flow runs in a headless/RPC session with no TUI observer
- **THEN** its run-scoped `flow:*` payloads SHALL still carry the run id

### Requirement: The flow result carries the run identity

`FlowResult` — the payload of `flow:complete` — SHALL carry the run identity for the completed run. The field is additive; results produced before this change (legacy) MAY omit it, mirroring the existing optional `status`.

#### Scenario: Completion result is attributable

- **WHEN** a flow completes and `flow:complete` is emitted with a `FlowResult`
- **THEN** the `FlowResult` SHALL carry the same run id as the run's other lifecycle events

#### Scenario: Reconciled orphan result carries the orphan's id

- **WHEN** an orphaned run is reconciled and a synthesized `FlowResult` is emitted
- **THEN** that result SHALL carry the orphaned run's id (read from the persisted record), not a live run's id
