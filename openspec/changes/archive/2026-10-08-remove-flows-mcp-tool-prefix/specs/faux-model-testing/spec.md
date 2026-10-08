## REMOVED Requirements

### Requirement: Tool-name prefix path coverage

**Reason**: pi-flows no longer prefixes tool names with `mcp__flows__`, so there is no second tool-name form to cover.
**Migration**: Tests that scripted `mcp__flows__finish` script `finish` instead. `spawnFaux` returns `finishToolName: "finish"` for every `modelApi`.

## ADDED Requirements

### Requirement: Anthropic-messages agents use unprefixed tool names

The faux suites SHALL verify that an agent whose model has `api: "anthropic-messages"` registers, activates and reports its tools under plain pi names, with no `mcp__flows__` prefix.

#### Scenario: Anthropic-messages agent finishes with plain finish

- **WHEN** a faux model is configured with `api: "anthropic-messages"` and the agent calls `finish`
- **THEN** the finish is captured correctly and `spawnFaux` reports `finishToolName` as `finish`

#### Scenario: Prefixed finish is not recognised

- **WHEN** a faux model is configured with `api: "anthropic-messages"` and the script calls `mcp__flows__finish`
- **THEN** the agent SHALL NOT complete via that call (no tool with that name is registered)
