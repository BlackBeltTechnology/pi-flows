# Spec Delta

## Purpose

Lets the parent session's model drive a flow like an orchestrator: start it, be notified of questions and the run's end, wait for either, answer questions, check status and cancel.

## ADDED Requirements

### Requirement: The parent starts a flow with `flow_run`
The main session SHALL have a `flow_run` tool taking `flow` and optional `task` and `inputs`. It SHALL start a parent-attached run through the shared dispatch path and return the `runId` once started, or an error result with the decline reason (unknown flow, already running, gate, invalid inputs). A missing `task` for a `task_required` flow SHALL be rejected as an invalid tool argument before dispatch.

#### Scenario: Start a flow
- **WHEN** the parent calls `flow_run({flow: "batch:apply", task: "plan.json"})` and no flow is running
- **THEN** the tool SHALL return the new run's `runId` while the flow runs in the background

#### Scenario: Already running
- **WHEN** the parent calls `flow_run` while a run is active
- **THEN** the tool SHALL return an error result with the engine's "already running" reason and SHALL NOT return the active run's id

#### Scenario: Task required
- **WHEN** the parent calls `flow_run` without `task` for a flow with `task_required: true`
- **THEN** the tool SHALL return an invalid-argument error result and no dispatch SHALL happen

#### Scenario: Invalid inputs
- **WHEN** the parent calls `flow_run` with inputs that fail the flow's input schema
- **THEN** the tool SHALL return an error result with the input diagnostic and no run SHALL start

### Requirement: Unseen questions and the run end are pushed to the parent
For a parent-attached run, when a question opens or the run ends and the parent is not blocked in `wait`, the engine SHALL deliver one visible message, built when sent, listing every open question not yet pushed or returned by `wait` (id, step, agent, item, options, delegation offer, timeout) and the unreported run outcome. Items within one second SHALL share a message; an empty batch SHALL send nothing. Delivery SHALL never interrupt a streaming parent and SHALL start a turn when it is idle.

#### Scenario: Parent idle when a question opens
- **WHEN** the parent is idle and an agent opens a question
- **THEN** a turn SHALL start in the parent with a message containing the question and its id

#### Scenario: Parallel questions batched
- **WHEN** three agents open questions within one second
- **THEN** the parent SHALL receive one message listing all three

#### Scenario: Parent streaming
- **WHEN** the parent is mid-turn and a question opens
- **THEN** the message SHALL be delivered after the current turn, not injected into it

#### Scenario: Run end pushed
- **WHEN** a parent-attached run ends with status `error`
- **THEN** the parent SHALL receive a message with the run's status and summary

#### Scenario: Detached run
- **WHEN** a detached run ends
- **THEN** no message SHALL be pushed to the parent

#### Scenario: Batch emptied before sending
- **WHEN** a question opens and a `wait` returns it before the batch is sent
- **THEN** no message SHALL be sent for it

### Requirement: The parent waits with `flow_control wait`
`flow_control {action: "wait"}` SHALL return at once with every open question no earlier `wait` returned and the run outcome if not yet returned by `wait`; otherwise it SHALL block until such an item appears or `timeout_s` passes (default 300 s, max 600 s). It SHALL return the run's progress and SHALL stop waiting when its tool call is aborted. While it blocks, nothing SHALL be pushed.

#### Scenario: Wait returns on a question
- **WHEN** the parent waits and an agent opens a question
- **THEN** `wait` SHALL return that question and no push SHALL be sent for it

#### Scenario: Pushed but unseen question
- **WHEN** a question was pushed during the parent's current turn and the parent calls `wait` in that turn
- **THEN** `wait` SHALL return that question at once

#### Scenario: Question already returned by wait
- **WHEN** a previous `wait` returned a still-open question and the parent waits again
- **THEN** `wait` SHALL keep blocking until a new question, the run end or the timeout

#### Scenario: Wait returns on run end
- **WHEN** the parent waits and the run completes
- **THEN** `wait` SHALL return the run's status and summary

#### Scenario: Nothing to wait for
- **WHEN** the parent waits with no active run and nothing unreported
- **THEN** `wait` SHALL return at once saying there is nothing to wait for

#### Scenario: Aborted wait
- **WHEN** the parent's `wait` tool call is aborted
- **THEN** `wait` SHALL return at once and the run SHALL keep going

### Requirement: The parent answers with `flow_control reply`
`flow_control {action: "reply"}` SHALL accept one answer (`question_id`, `answer` as text or list, optional `notes`, optional `decide`) or several (`replies: [...]`), and report per question `answered`, `invalid` (with the reason and valid options) or `not_pending`. Each accepted answer SHALL resume its asker.

#### Scenario: Answer two questions at once
- **WHEN** the parent replies `{replies: [{question_id: "<q1>", answer: "yes"}, {question_id: "<q2>", answer: "no"}]}`
- **THEN** both askers SHALL resume and both outcomes SHALL be `answered`

#### Scenario: Unknown question
- **WHEN** the parent replies to a closed or unknown `question_id`
- **THEN** that outcome SHALL be `not_pending`

### Requirement: The parent checks and cancels with `flow_control status` and `cancel`
`status` SHALL return the active parent-attached run's id, flow, per-node status and open questions with no side effect; node status SHALL come from the read-only run-state seam. `cancel` SHALL cancel that run, which SHALL end `aborted` with its questions closed. Every `flow_control` action SHALL act only on a parent-attached run and SHALL report that there is none when the active run is detached. `flow_control` itself is not the read-only seam.

#### Scenario: Status lists open questions
- **WHEN** a run has one open question and the parent calls `status`
- **THEN** the result SHALL list that question and the run's node statuses, and a later `wait` SHALL still return that question

#### Scenario: Cancel
- **WHEN** the parent calls `flow_control {action: "cancel"}`
- **THEN** the run SHALL end `aborted` and its open questions SHALL be closed

#### Scenario: Detached run is out of reach
- **WHEN** a host automation's detached run is active and the parent calls `flow_control {action: "cancel"}`
- **THEN** the tool SHALL report that no parent-attached run is active and the run SHALL keep going

### Requirement: Question lifecycle events are emitted and persisted
The engine SHALL emit `flow:question` when a question opens (runId, `question_id`, step, agent, item, kind, question, options, timeout) and `flow:answer` when it closes (`via`: `reply`, `timeout` or `cancel`), persisted in order with the run's other flow events. A run's questions SHALL close before its `flow:complete`; orphan reconciliation SHALL close questions left open.

#### Scenario: Answered question
- **WHEN** a question opens and the parent replies
- **THEN** `flow:question` then `flow:answer` with `via: "reply"` SHALL be emitted with the same `question_id` and runId

#### Scenario: Timed-out question
- **WHEN** a question times out
- **THEN** `flow:answer` with `via: "timeout"` SHALL be emitted

#### Scenario: Closed before completion
- **WHEN** a run ends with a question still open
- **THEN** its `flow:answer` with `via: "cancel"` SHALL be persisted before the run's `flow:complete`

#### Scenario: Persisted for resume
- **WHEN** a session whose run asked a question is resumed
- **THEN** the persisted flow events SHALL include that `flow:question` and its `flow:answer`

#### Scenario: Interrupted run
- **WHEN** a run is interrupted by session close with a question open and the session resumes
- **THEN** reconciliation SHALL persist a `flow:answer` with `via: "cancel"` for it before the run's terminal record
