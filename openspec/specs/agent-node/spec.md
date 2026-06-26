# agent-node Specification

## Purpose
TBD - created by archiving change enhance-agent-node-contract. Update Purpose after archive.
## Requirements
### Requirement: Agent frontmatter supports `fork_session`

The agent frontmatter SHALL accept an optional boolean `fork_session`. When omitted it defaults to `false`.

#### Scenario: fork_session omitted defaults to in-memory

- **WHEN** an agent file declares no `fork_session` field
- **THEN** `AgentConfig.fork_session` SHALL be `undefined` or `false`
- **AND** `spawnAgent` SHALL create the session with `SessionManager.inMemory()`.

#### Scenario: fork_session true with a persisted main session

- **WHEN** `fork_session: true` and the main session exposes a session file via `getSessionFile()`
- **THEN** `spawnAgent` SHALL create the subagent session from `SessionManager.forkFrom(<main session file>, cwd)`
- **AND** the subagent SHALL inherit the operator's conversation data
- **AND** subagent writes SHALL land in the forked child session, not the operator's live leaf.

#### Scenario: fork_session true but main session not persisted

- **WHEN** `fork_session: true` and `getSessionFile()` returns `undefined`
- **THEN** `spawnAgent` SHALL fall back to `SessionManager.inMemory()`
- **AND** SHALL surface a non-fatal diagnostic noting the fallback.

### Requirement: Agent frontmatter supports `context_files`

The agent frontmatter SHALL accept an optional string array `context_files`. Each entry is a path read at spawn and injected into the agent's system prompt as a preamble section.

#### Scenario: context files injected as preamble

- **WHEN** an agent declares `context_files: [AGENTS.md, docs/conventions.md]`
- **THEN** at spawn each path SHALL be resolved relative to `cwd` and read
- **AND** each file's contents SHALL be injected as a `## Context: <path>` section ahead of the agent body.

#### Scenario: missing context file is skipped

- **WHEN** a `context_files` entry points to a path that does not exist or cannot be read
- **THEN** that entry SHALL be skipped with a non-fatal diagnostic
- **AND** the spawn SHALL proceed with the remaining context files.

### Requirement: Declared outputs carry optional `type` and `pattern`

An output entry SHALL accept optional `type` (`string` | `number` | `boolean`) and `pattern` (regex). Output values remain string-valued; `type` and `pattern` constrain the string content. Inputs SHALL NOT carry type or pattern metadata.

#### Scenario: parse outputs with type and pattern

- **WHEN** an agent declares an expanded output with `type: number` and/or `pattern: "^/.+"`
- **THEN** `AgentConfig.outputs[i]` SHALL include the parsed `type` and/or `pattern`
- **AND** outputs declared as bare names SHALL parse with `type` and `pattern` absent.

#### Scenario: extracted outputs remain strings

- **WHEN** the agent supplies a declared output via `finish`
- **THEN** the extracted value in `typedOutputs` SHALL be a string
- **AND** `typedOutputs` SHALL remain `Record<string, string>` regardless of declared `type`.

### Requirement: Finish tool enforces declared outputs at the schema level

The finish tool's TypeBox schema SHALL make declared outputs required and SHALL encode `type`/`pattern` as string constraints so the SDK rejects a non-conforming `finish` call.

#### Scenario: declared output is required

- **WHEN** an agent declares output `verdict` and calls `finish` without it
- **THEN** the `finish` schema validation SHALL fail (`tool_execution_end.isError`)
- **AND** the existing finish followUp retry SHALL re-prompt the agent
- **AND** the step SHALL fail after `MAX_FINISH_RETRIES` are exhausted.

#### Scenario: pattern mismatch is rejected

- **WHEN** an output declares `pattern: "^/.+"` and the agent supplies a value not matching that regex
- **THEN** the `finish` schema validation SHALL fail and trigger the retry path.

#### Scenario: type maps to a string constraint

- **WHEN** an output declares `type: number`
- **THEN** the finish schema SHALL constrain the value to a numeric string
- **AND** `type: boolean` SHALL constrain the value to `"true"` or `"false"`.

#### Scenario: explicit pattern wins over type

- **WHEN** an output declares both `type` and an explicit `pattern`
- **THEN** the explicit `pattern` SHALL be used as the schema constraint.

#### Scenario: invalid regex degrades gracefully

- **WHEN** an output declares a `pattern` that is not a valid regex
- **THEN** the finish schema SHALL fall back to a plain required string for that output
- **AND** a parser diagnostic SHALL be surfaced
- **AND** the spawn SHALL NOT crash.

### Requirement: Agent node behavior has test coverage

The package SHALL include test suites covering agent frontmatter parsing, finish-schema construction, output validation, context-file injection, and session-fork behavior.

#### Scenario: suites exercise the new contract

- **WHEN** `npm test` runs
- **THEN** suites SHALL assert: parsing of `fork_session`/`context_files`/typed-pattern outputs; required + pattern + type finish-schema construction; valid/missing/mismatch output validation; context-file injection incl. missing-file skip; and `forkFrom` vs `inMemory` selection.

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

