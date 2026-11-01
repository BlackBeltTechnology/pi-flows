## ADDED Requirements

### Requirement: The decision agent is selected from step, flow, settings, then built-in

For a `fork` decided autonomously and for an `agent-decision` step, the engine SHALL use the first agent named by: the step's `agent:`; the flow's top-level `decision_agent:`; the setting `flows.decisionAgent` (project settings override global); the built-in `flow-decision` agent. An `agent-decision` step MAY omit `agent:`. A named agent that does not exist SHALL fail the step with an error naming the agent and where it was configured.

#### Scenario: Flow-level decision agent applies to steps without agent

- **GIVEN** a flow with `decision_agent: my-router` and a `fork` step without `agent:`
- **WHEN** the fork is decided autonomously
- **THEN** the `my-router` agent SHALL make the decision

#### Scenario: Settings decision agent applies when the flow names none

- **GIVEN** setting `flows.decisionAgent: "team-router"` and a flow without `decision_agent:`
- **WHEN** an `agent-decision` step without `agent:` runs
- **THEN** the `team-router` agent SHALL make the decision

#### Scenario: Step agent wins

- **GIVEN** a flow with `decision_agent: my-router` and an `agent-decision` step with `agent: verifier`
- **WHEN** the step runs
- **THEN** the `verifier` agent SHALL make the decision

#### Scenario: Built-in fallback

- **GIVEN** no step `agent:`, no flow `decision_agent:` and no `flows.decisionAgent`
- **WHEN** a decision is made
- **THEN** the built-in `flow-decision` agent SHALL make it

#### Scenario: Configured agent missing

- **GIVEN** setting `flows.decisionAgent: "nope"` and no agent named `nope`
- **WHEN** a decision step without `agent:` runs
- **THEN** the step SHALL fail with an error naming `nope` and `flows.decisionAgent`

#### Scenario: Built-in decision agent works without a resolver

- **GIVEN** no `model:resolve` handler AND a parent session model
- **WHEN** the built-in `flow-decision` agent (declared `model: @fast`) makes a decision
- **THEN** it SHALL run on the parent session model without a resolution error
