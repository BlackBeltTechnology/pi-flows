# Spec Delta

## Purpose

Lets flow agents, their extension prompts and fork steps get a decision from the parent session's model instead of a human dialog: the asker parks until the parent answers, several questions may be open at once, and an optional timeout returns a default steering text.

## ADDED Requirements

### Requirement: A run is parent-attached only when its starter can answer
A run SHALL be parent-attached when started by the `flow_run` tool, by `flow:run` with `notifyParent: true`, or by a slash command in a session with a UI (interactive or RPC). Every other run SHALL be detached and SHALL never open a question.

#### Scenario: flow_run
- **WHEN** the parent model starts a flow with `flow_run`, in any session mode
- **THEN** the run SHALL be parent-attached (in print/JSON mode the parent receives questions through `flow_control wait`, since no later turn may follow)

#### Scenario: Slash command in an interactive session
- **WHEN** a flow is started with its slash command in an interactive session
- **THEN** the run SHALL be parent-attached

#### Scenario: Slash command in print mode
- **WHEN** a flow is started with its slash command in print or JSON mode
- **THEN** the run SHALL be detached

#### Scenario: Host automation dispatch
- **WHEN** a host emits `flow:run` without `notifyParent`
- **THEN** the run SHALL be detached

### Requirement: Worker agents ask the parent with `ask_parent`
In a parent-attached run, every worker `agent` step (not decision agents or deciders) SHALL have an `ask_parent` tool regardless of its `tools:` list, taking `question` and optional `options`, `multiSelect`, `allowCustom`, `timeout_s`, `default`. A call SHALL open a question and park the agent until it closes; the result SHALL be the answer text.

#### Scenario: Agent receives the parent's answer
- **WHEN** an agent calls `ask_parent({question: "Use v2 API?"})` and the parent replies `"yes, v2"`
- **THEN** the call SHALL return `"yes, v2"` and the agent SHALL continue its turn

#### Scenario: Agent parks without a timeout
- **WHEN** an agent calls `ask_parent` without `timeout_s` and no reply arrives for 30 minutes
- **THEN** the agent SHALL still be parked and the question SHALL still be open

#### Scenario: Available despite a tools allowlist
- **WHEN** a worker agent declares `tools: read, grep` in a parent-attached run
- **THEN** it SHALL be able to call `ask_parent`

#### Scenario: Autonomous mode does not disable it
- **WHEN** autonomous mode is on and a worker agent of a parent-attached run calls `ask_parent`
- **THEN** a question SHALL open

#### Scenario: Detached run
- **WHEN** a run is detached
- **THEN** its agents SHALL NOT have `ask_parent`

#### Scenario: Decision agents excluded
- **WHEN** an `agent-decision` agent or a fork decider runs in a parent-attached run
- **THEN** it SHALL NOT have `ask_parent`, and its extension prompts SHALL resolve as cancelled, because deciders are automated routers often invoked on the parent's behalf (asking back would loop)

### Requirement: Invalid `ask_parent` arguments return an error
`ask_parent` SHALL return an error result without opening a question when `question` is empty, `timeout_s` is not an integer from 1 to 86400, `default` is given without `timeout_s`, or `default` is not one of `options` while `options` are given and `allowCustom` is off.

#### Scenario: Default without timeout
- **WHEN** an agent calls `ask_parent({question: "x", default: "y"})`
- **THEN** the call SHALL return an error result and no question SHALL open

### Requirement: A timed-out question returns the default text
When `timeout_s` passes without a reply, the question SHALL close and the asker SHALL receive `default`, or without it a built-in text saying no answer came and the agent must decide and state its assumption. A later reply SHALL be rejected as not pending.

#### Scenario: Custom default on timeout
- **WHEN** an agent calls `ask_parent({question, timeout_s: 60, default: "Skip the migration"})` and no reply arrives within 60 s
- **THEN** the call SHALL return `"Skip the migration"` and the question SHALL be closed

#### Scenario: Built-in default on timeout
- **WHEN** an agent calls `ask_parent({question, timeout_s: 60})` and no reply arrives
- **THEN** the call SHALL return a text stating the parent did not answer and the agent must decide and state its assumption

#### Scenario: Late reply
- **WHEN** the parent replies after the question timed out
- **THEN** the reply SHALL be rejected as not pending

### Requirement: Several questions may be open at once
Questions from parallel steps, fan-out instances and extension prompts SHALL be open concurrently. Each SHALL have a `question_id` unique within the process and not derived from a counter, and SHALL record its run, step, agent and, for fan-out, item index. Each asker SHALL park and resume independently.

#### Scenario: Two parallel agents ask
- **WHEN** parallel steps `a` and `b` each call `ask_parent`
- **THEN** two questions SHALL be open with distinct ids, recording steps `a` and `b`
- **AND** replying to `b`'s question SHALL resume only `b`

#### Scenario: Fan-out instances ask
- **WHEN** instances 0 and 2 of a fan-out step each call `ask_parent`
- **THEN** each open question SHALL record its item index

### Requirement: Option questions validate the answer
A reply to an `ask_parent` or extension question with `options` SHALL be accepted only if it names one option, several with `multiSelect` (as a list), or free text with `allowCustom`. Fork replies follow the fork rules below. A rejected reply SHALL leave the question open and report the valid options.

#### Scenario: Invalid option
- **WHEN** a question has options `["a", "b"]` without `allowCustom` and the parent replies `"c"`
- **THEN** the reply SHALL be rejected listing `a` and `b`, and the question SHALL stay open

#### Scenario: Multi-select answer
- **WHEN** a question has options `["a", "b", "c"]` with `multiSelect` and the parent replies `["a", "c"]`
- **THEN** the asker SHALL receive both selections

### Requirement: Agent extension prompts become parent questions
In a parent-attached run, `ctx.ui.select`, `confirm` and `input` called by a worker agent's extension tools SHALL open parent questions (the options; `yes`/`no`; free text) recording the step and item, and resolve with the reply. The prompt's own `signal` and `timeout` SHALL close the question. In a detached run they SHALL resolve as cancelled.

#### Scenario: Extension confirm
- **WHEN** an agent's extension tool calls `ctx.ui.confirm("Overwrite?")` in a parent-attached run and the parent replies `"yes"`
- **THEN** the confirm SHALL resolve `true`

#### Scenario: Extension prompt aborted
- **WHEN** an extension prompt's own signal aborts while its question is open
- **THEN** the question SHALL close with `via: "cancel"` and the prompt SHALL resolve as cancelled

### Requirement: Fork steps ask the parent
A fork in a parent-attached run SHALL ask the parent with its expanded question and options, honouring `multiSelect`, regardless of autonomous mode. The answer SHALL select the branch(es); reply notes SHALL become the fork's notes; the recorded fork answer SHALL stay text (selections joined).

#### Scenario: Parent picks a branch
- **WHEN** a fork with options `["fix", "skip"]` asks and the parent replies `"skip"` with notes `"flaky test"`
- **THEN** the flow SHALL take the `skip` branch and the fork's notes SHALL be `"flaky test"`

#### Scenario: Parent picks several branches
- **WHEN** a `multiSelect` fork asks and the parent replies `["fix", "skip"]`
- **THEN** both branches SHALL be taken

#### Scenario: Autonomous mode on
- **WHEN** autonomous mode is on and a fork of a parent-attached run is reached
- **THEN** the fork SHALL ask the parent

### Requirement: The parent may delegate a fork to its decider
When a fork has a decider, its question SHALL offer delegation, and with `allowCustom` accept free text. A `decide` reply, or free text, SHALL resolve the fork through its decider chain steered by the notes or text, without changing the global autonomous setting. Without a decider, a fork reply SHALL name its option(s); `decide` and free text SHALL be rejected as invalid even with `allowCustom`.

#### Scenario: Delegation
- **WHEN** a fork with a decider asks and the parent replies `decide` with notes `"prefer the safe path"`
- **THEN** the fork SHALL be resolved by its decider with those notes, and autonomous mode SHALL be unchanged

#### Scenario: Free text steers the decider
- **WHEN** an `allowCustom` fork with a decider asks and the parent replies `"only the docs changed"`
- **THEN** the decider SHALL resolve the fork with that text as guidance

#### Scenario: No decider
- **WHEN** a fork without a decider asks and the parent replies `decide`
- **THEN** the reply SHALL be rejected as invalid and the question SHALL stay open

### Requirement: An exhausted delegation routes to on_error or is re-asked once
If the delegated decider chain produces no valid branch, a fork with `on_error` SHALL route there as today; otherwise it SHALL open one new question stating why, offering only its options (no delegation, no free text).

#### Scenario: Decider exhausted without on_error
- **WHEN** a delegated decider of a fork without `on_error` yields no valid branch
- **THEN** a new question SHALL open for the same fork with the reason in its text, accepting only the fork's options

#### Scenario: Decider exhausted with on_error
- **WHEN** a delegated decider of a fork with `on_error: recover` yields no valid branch
- **THEN** the flow SHALL route to `recover` without a new question

### Requirement: Fork steps may declare a timeout and default
A fork MAY declare `ask_timeout_s` (integer 1–86400) and `ask_default` (an option, or a list of options for `multiSelect`). On timeout the fork SHALL take the `ask_default` branch(es). Loading or validating a flow SHALL reject an out-of-range timeout, an `ask_default` that is not among the options, and either field without the other.

#### Scenario: Fork times out
- **WHEN** a fork with `ask_timeout_s: 120` and `ask_default: "skip"` gets no reply in 120 s
- **THEN** the flow SHALL take the `skip` branch

#### Scenario: Invalid default
- **WHEN** a flow file declares a fork with `ask_default: "maybe"` and options `["fix", "skip"]`
- **THEN** loading or validating the flow SHALL report an error

### Requirement: Questions close when their asker can no longer continue
Every open question SHALL close, and later replies SHALL be rejected as not pending, when the run ends for any reason (success, error, hard-fail halt, cancel) or the asking step is aborted. A closed agent question SHALL stop the parked call; a closed fork question SHALL end the fork as cancelled without routing and without an unhandled rejection.

#### Scenario: Run cancelled while asking
- **WHEN** a run with two open questions is cancelled
- **THEN** both questions SHALL close and the run SHALL end `aborted`

#### Scenario: Hard-fail halt
- **WHEN** a step hard-fails while another step's question is open
- **THEN** the open question SHALL close and the run SHALL halt

#### Scenario: Fork question closed
- **WHEN** a fork's question is closed by a cancel
- **THEN** no branch of the fork SHALL run

### Requirement: Detached runs never ask
In a detached run no question SHALL open: forks SHALL resolve through their decider chain in autonomous mode and take their first option otherwise, and extension prompts SHALL resolve as cancelled. In a session with a UI this replaces the former human dialogs.

#### Scenario: Detached fork, autonomous off
- **WHEN** a detached run with autonomous mode off reaches a fork
- **THEN** the fork SHALL take its first option without opening a question

#### Scenario: Detached fork, autonomous on
- **WHEN** a detached run with autonomous mode on reaches a fork with a decider
- **THEN** the fork SHALL be resolved by its decider chain
