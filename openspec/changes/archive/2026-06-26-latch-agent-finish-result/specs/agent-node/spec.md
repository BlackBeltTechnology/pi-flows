## ADDED Requirements

### Requirement: First correct finish is latched and ends the step

The agent harness SHALL capture `finish` arguments from the `tool_execution_end` event (keyed by `toolCallId`), and SHALL freeze the result of the first `finish` whose end is not an error. Once a correct `finish` is latched, the harness SHALL ignore every subsequent `finish` end (success or error) and SHALL NOT overwrite or clear the latched result. The harness SHALL call `session.abort()` exactly once, when the latch is set, to stop the step after the correct finish.

#### Scenario: duplicate finish in one assistant message — first correct wins

- **WHEN** an assistant message contains two `finish` tool calls and they execute as a parallel batch (the duplicate's error end arrives before the first call's success end)
- **THEN** the harness SHALL latch the result from the successful `finish` end
- **AND** the duplicate's error end SHALL NOT clear the latched result
- **AND** the step SHALL resolve with the latched `finishParams` and `outcome` derived from it.

#### Scenario: finish end captured by toolCallId, not by start event

- **WHEN** a later `finish` call emits its `tool_execution_start` after an earlier `finish` call has started
- **THEN** the later start event SHALL NOT overwrite the args captured for the earlier call
- **AND** the latched result SHALL correspond to the first successful `finish` end's `toolCallId`.

#### Scenario: abort fires once on latch

- **WHEN** the first correct `finish` end is observed
- **THEN** `session.abort()` SHALL be called once
- **AND** subsequent `finish` ends SHALL NOT trigger additional aborts.

### Requirement: Finish re-prompting is driven by the latch, not per-event errors

The harness SHALL NOT queue a followUp from within the per-event `finish` end handler. Re-prompting SHALL occur only at the post-prompt stop-gate, conditioned on the absence of a latched correct `finish` (`!finishLatched`), bounded by a single retry counter. A malformed single `finish` SHALL be allowed to self-correct via the model's natural retry on the returned error tool result.

#### Scenario: malformed finish then correct finish

- **WHEN** an agent's first `finish` fails schema validation (`tool_execution_end.isError`) and is not latched
- **THEN** no followUp SHALL be queued from the event handler
- **AND** the model SHALL receive the error tool result and may retry
- **AND** a subsequent correct `finish` SHALL be latched and end the step.

#### Scenario: agent never produces a correct finish

- **WHEN** the agent stops without ever latching a correct `finish`
- **THEN** the stop-gate SHALL re-prompt up to its retry bound
- **AND** if still unlatched, the step SHALL resolve as `soft` / `agent_no_finish` via `classifyAgentOutcome`
- **AND** the result SHALL NOT be left in an unknown status that silently halts the flow.

#### Scenario: latched abort is not treated as a user abort

- **WHEN** the session is aborted because a correct `finish` was latched
- **THEN** the tail's `aborted && !finishParams` user-abort branch SHALL NOT apply
- **AND** the step SHALL resolve from the latched `finishParams`.
