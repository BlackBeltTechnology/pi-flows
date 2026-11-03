# Spec Delta

## Purpose

Lets flow decision points be answered by classifier models (System One or pi-ai classifiers) before, or instead of, a full decision agent, with or without pi-agent-dashboard, and never by a silent default.

## ADDED Requirements

### Requirement: Decision points use an ordered decider chain

Autonomous `fork` decisions, fork "Other" mapping and `agent-decision` steps SHALL be answered by a decider chain of entries `system-one`, `provider/model` (a pi-ai classifier) or `agent`. The chain SHALL come from the step's `decider:`, else the flow's `decider:`, else the `flows.decider` setting, else `[agent]`. Entries SHALL be tried in order; the first trusted, valid label routes.

#### Scenario: Flow decider applies to steps without one
- **GIVEN** a flow with `decider: [system-one, agent]` and a step without `decider:`
- **WHEN** the step runs
- **THEN** System One SHALL be tried before the agent

#### Scenario: Default chain keeps today's behaviour
- **GIVEN** no step, flow or settings `decider`
- **WHEN** an `agent-decision` step runs
- **THEN** only the decision agent SHALL be consulted, as before this change

#### Scenario: Classifier first, agent as fallback
- **GIVEN** `decider: [typesafe/jev-latest, agent]` and the classifier returns a trusted label `done`
- **WHEN** the step runs
- **THEN** the flow SHALL route on `done` AND no decision agent SHALL be spawned

#### Scenario: Step decider overrides settings
- **GIVEN** setting `flows.decider: [system-one, agent]` and a step with `decider: [agent]`
- **WHEN** the step runs
- **THEN** System One SHALL NOT be called

#### Scenario: Unknown decider entry rejected at validation
- **WHEN** a flow declares `decider: [magic]`
- **THEN** flow validation SHALL report an error naming `magic` and the allowed entry forms

### Requirement: Decisions map to one classifier choice question

A classifier entry SHALL receive one `choice` question whose criteria map each branch label to its `means` (else the label; for a fork, each option to itself) and whose instructions are the expanded `task` (a fork without `task`: its `question`). The state SHALL be the expanded `state:` map, else `{ task }`, plus `question` and `userText` for fork "Other".

#### Scenario: Fork Other text is in the state
- **WHEN** a user types "ship it anyway" as the "Other" answer to a fork and a classifier entry is tried
- **THEN** the state SHALL contain `question` and `userText: "ship it anyway"` AND the criteria SHALL be the fork options

#### Scenario: Branch descriptions become criteria
- **GIVEN** branches `done: { to: report, means: "No blocking issues" }` and `fix: { to: fixer, means: "Blocking issue found" }`
- **WHEN** a classifier entry is tried
- **THEN** the question SHALL be `{ type: "choice", criteria: { done: "No blocking issues", fix: "Blocking issue found" } }`

#### Scenario: Declared state is expanded
- **GIVEN** `state: { review: "${{result.review.summary}}" }`
- **WHEN** a classifier entry is tried
- **THEN** the classifier state SHALL contain `review` set to the review step's summary

#### Scenario: Missing branch descriptions warn
- **WHEN** a decision step whose decider chain contains a classifier entry has a branch without `means`
- **THEN** flow validation SHALL report a warning naming the branch

### Requirement: The decision agent receives the classifier inputs

When the `agent` entry decides an `agent-decision` or `fork`, the agent's task SHALL be the expanded `task` followed by a list of every branch label with its `means` (when given) and, when `state:` is declared, every expanded `state:` entry. An agent-routed decision SHALL NOT have less context than a classifier-routed one.

#### Scenario: State and means reach the decision agent
- **GIVEN** `state: { review: "${{result.work.summary}}" }` and branches with `means`
- **WHEN** the decision agent is spawned
- **THEN** its task SHALL contain the expanded `review` value, each branch label and each branch's `means`

#### Scenario: No state declared
- **WHEN** a decision step declares no `state:` and no `means`
- **THEN** the decision agent's task SHALL contain the expanded `task` and the branch labels, and no state section

### Requirement: Trust policy decides whether a classifier answer routes

A classifier answer SHALL route only when trusted under `trust` (default `auto`) and `min_confidence` (default `0.75`). `calibrated` SHALL require System One mode `enforce`; `confidence` SHALL require confidence ≥ `min_confidence`; `auto` SHALL act as `calibrated` when a System One calibration record exists for that backend and decision point, else as `confidence`. An untrusted answer SHALL be recorded as shadow and the chain SHALL continue.

#### Scenario: Low confidence falls through
- **GIVEN** `decider: [typesafe/jev-latest, agent]` and trust `confidence` with `min_confidence: 0.75`
- **WHEN** the classifier returns `done` with confidence `0.6`
- **THEN** the decision agent SHALL decide AND the classifier answer SHALL be recorded as shadow

#### Scenario: Calibrated shadow does not route
- **GIVEN** trust `auto` AND System One has a calibration record in `shadow` mode for this backend and decision point
- **WHEN** System One returns `done` with confidence `0.99`
- **THEN** the answer SHALL NOT route AND the next chain entry SHALL decide

#### Scenario: Uncalibrated System One without dashboard
- **GIVEN** trust `auto`, no calibration record, and System One returns `done` with confidence `0.9`
- **WHEN** the step runs
- **THEN** the flow SHALL route on `done`

### Requirement: System One entries use the standalone library

A `system-one` entry SHALL call `predict()` from `@blackbelt-technology/pi-system-one` with consumer id `pi-flows:<flow>:<step>` (lowercased; characters outside `[a-z0-9:._-]` replaced with `-`; truncated to 128), failure policy `fail-open`, the run's `cwd` and pi's project-trust decision, and an `llm` caller supplied by pi-flows. It SHALL work when pi-agent-dashboard is absent. A `predict()` result with `ok: false` SHALL be a failed attempt carrying its reason.

#### Scenario: No System One configuration
- **GIVEN** no `~/.pi/agent/system-one.json` and no project `.pi/system-one.json`
- **WHEN** a `system-one` entry is tried
- **THEN** the attempt SHALL fail with reason `no-backend` without network access AND the chain SHALL continue

#### Scenario: Dashboard sees the decision point
- **GIVEN** the dashboard's System One configuration exists
- **WHEN** a `system-one` entry is tried for step `review-gate` in flow `ship`
- **THEN** System One SHALL register consumer `pi-flows:ship:review-gate`

#### Scenario: llm backend works in plain pi
- **GIVEN** a System One chain whose only backend is `llm` with role `@fast` AND no dashboard running
- **WHEN** a `system-one` entry is tried
- **THEN** pi-flows' caller SHALL answer with one structured completion on the model resolved for `@fast` (session model fallback applies) AND SHALL NOT spawn an agent session

### Requirement: pi-ai classifier entries call the model registry

An entry of the form `provider/model` SHALL resolve to a pi-ai classifier model and call `modelRegistry.classify(model, { state, questions })`. A ref that is not a known classifier model SHALL be a validation error when the flow is written and a failed attempt at run time. Missing credentials SHALL be a failed attempt with a reason naming the provider.

#### Scenario: Missing key falls through
- **GIVEN** `decider: [typesafe/jev-latest, agent]` and no TypeSafe credential
- **WHEN** the step runs
- **THEN** the classifier attempt SHALL fail with a reason naming `typesafe` AND the agent SHALL decide

#### Scenario: Chat model is not a classifier
- **WHEN** a flow declares `decider: [anthropic/claude-haiku-4-5]`
- **THEN** validation SHALL report that the ref is not a classifier model

### Requirement: Off-machine classification follows the System One privacy switch

When `~/.pi/agent/system-one.json` or a trusted project's `.pi/system-one.json` sets `allowOffMachine: false`, a pi-ai classifier entry whose model does not run on this machine (a non-loopback base URL) SHALL fail with reason `off-machine` without sending any request. A project file SHALL only tighten this. The configuration SHALL be read on every flow run. Without a System One configuration no extra gate SHALL apply.

#### Scenario: Hosted classifier blocked by privacy switch
- **GIVEN** `~/.pi/agent/system-one.json` with `allowOffMachine: false` AND `decider: [openai/gpt-6-luna, agent]`
- **WHEN** the step runs
- **THEN** no request SHALL reach OpenAI AND the attempt SHALL fail with reason `off-machine`

#### Scenario: Trusted project tightens the switch
- **GIVEN** no user System One file AND a trusted project's `.pi/system-one.json` with `allowOffMachine: false`
- **WHEN** a hosted pi-ai classifier entry is tried
- **THEN** it SHALL fail with reason `off-machine` without sending a request

#### Scenario: Local classifier allowed
- **GIVEN** `allowOffMachine: false` AND a llama.cpp classifier on `127.0.0.1`
- **WHEN** the entry is tried
- **THEN** the classifier SHALL be called

### Requirement: An exhausted chain fails instead of defaulting

A classifier label that is not a branch key or fork option SHALL be a failed attempt. An `agent` entry whose agent returns no valid branch SHALL be a failed attempt. When every entry fails, an interactive fork SHALL ask the user, and otherwise the step SHALL fail with an error listing each attempt and its reason. The engine SHALL NOT route to the first branch by default.

#### Scenario: Invalid label is not routed
- **GIVEN** `decider: [system-one]` and System One returns label `maybe`, which is not a branch
- **WHEN** the step runs
- **THEN** the step SHALL fail with an error naming `maybe` and the valid labels

#### Scenario: Agent without a branch fails the step
- **GIVEN** `decider: [agent]` and the agent finishes without a valid `branch`
- **WHEN** the `agent-decision` step completes
- **THEN** the step SHALL fail AND SHALL NOT route to the first branch

#### Scenario: Aborted run stops the chain
- **WHEN** the flow is aborted while a classifier call is in flight
- **THEN** the call SHALL be cancelled AND no further chain entry SHALL be tried

### Requirement: Every decision emits a flow:decision event

After each decision the engine SHALL emit `flow:decision` with the step id, the consumer id, the chain, every attempt (entry, label, confidence, mode, trusted, latency, failure reason) and the entry that routed. A shadow answer SHALL carry `agreed: true|false` relative to the routed label. The event SHALL NOT contain the decision state. The TUI decision line SHALL show the routing entry and, for classifiers, its confidence.

#### Scenario: Shadow agreement recorded
- **GIVEN** `decider: [system-one, agent]`, System One answers `done` in shadow mode and the agent then returns `done`
- **WHEN** the event is emitted
- **THEN** the System One attempt SHALL have `trusted: false` and `agreed: true` AND the routing entry SHALL be `agent`

#### Scenario: State stays out of events
- **WHEN** any `flow:decision` event is emitted
- **THEN** its payload SHALL NOT include the classifier state or the expanded task text
