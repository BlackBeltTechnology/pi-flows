# subagent-spawn Specification

## Purpose
TBD - created by archiving change fix-subagent-tool-injection. Update Purpose after archive.
## Requirements
### Requirement: spawnAgent passes tool NAMES (not objects) to createAgentSession

The flow engine's `spawnAgent` SHALL pass `tools` to `pi-coding-agent`'s `createAgentSession` as either `undefined` or a `string[]` of lowercase pi tool names. It SHALL NEVER pass an array of tool definition objects.

The rationale: `pi-coding-agent` treats the `tools` option as an allowlist of names. Passing objects produces a Set of `[object Object]` strings that never match real tool names, which filters EVERY tool out of the session — including the agent's declared tools, the guard's `finish` tool, and any `extraCustomTools` (`agent_catalog`, `agent_write`, `flow_write`, …).

#### Scenario: spawnAgent omits the SDK tool filter

- **WHEN** `spawnAgent` calls `createAgentSession`
- **THEN** the `tools` option SHALL be `undefined` OR a `string[]` of lowercase pi tool names (e.g. `["read", "grep", "find"]`)
- **AND** `tools` SHALL NOT be an array containing any non-string entries.

### Requirement: spawnAgent activates the correct prefixed tool set after bindExtensions

After `session.bindExtensions(...)` returns, `spawnAgent` SHALL call `session.setActiveToolsByName(...)` with the array of names the agent should expose on the wire. The array SHALL include:

1. Prefixed built-in pi tool names (e.g. `Read`/`Bash`/`Grep` for `anthropic-messages`; `read`/`bash`/`grep` for other providers).
2. Every entry from `customTools` (already prefixed during the spawnAgent map).
3. The guard extension's prefixed `finish` tool name.

Calling `setActiveToolsByName` MUST happen AFTER `bindExtensions` because the guard's `finish` tool registers itself into the session's tool registry during bind.

#### Scenario: Active tool list includes the guard's finish

- **WHEN** `spawnAgent` activates tools for a flow architect running on `anthropic-messages`
- **THEN** `setActiveToolsByName` SHALL be called with an array that includes `mcp__flows__finish`
- **AND** the agent's outbound wire payload's `tools[]` SHALL contain `mcp__flows__finish`.

#### Scenario: Active tool list includes prefixed customTools

- **WHEN** `spawnAgent` activates tools for the flow architect (which receives `agent_catalog`, `agent_write`, `flow_write` via `extraCustomTools`)
- **THEN** `setActiveToolsByName` SHALL include `mcp__flows__agent_catalog`, `mcp__flows__agent_write`, `mcp__flows__flow_write` (when `anthropic-messages`).

### Requirement: extraCustomTools are passed as ToolDefinition objects, with prefixed names

`spawnAgent` SHALL forward `options.extraCustomTools` (an array of ToolDefinition objects with `.execute()`) to `createAgentSession({ customTools })` after rewriting each tool's `name` through `prefixToolName(name, toolPrefix)`.

The SDK adds these to `_toolRegistry` independently of the `allowedToolNames` filter, so they reach the wire regardless of whether `tools` is set or `undefined`.

#### Scenario: customTools survive the SDK registry build

- **WHEN** `spawnAgent` passes `customTools: [{name: "mcp__flows__agent_catalog", execute, parameters, ...}, ...]`
- **THEN** the resulting `AgentSession._toolRegistry` SHALL contain a `mcp__flows__agent_catalog` entry with the executable definition.
- **AND** when `setActiveToolsByName` includes that name, the outbound payload `tools[]` SHALL include `mcp__flows__agent_catalog`.

### Requirement: Subagent sandbox uses guard extension, not SDK allowlist

The subagent's tool sandbox (which tools the agent may call) SHALL be enforced by the guard extension's `tool_call` event blocker — NOT by the SDK's `allowedToolNames` filter. This is because passing `tools: undefined` disables the SDK filter (Requirement above).

The guard extension SHALL block any `tool_call` event whose `toolName` is not in `[...agent.tools, "finish"]` (each name prefixed via `prefixToolName`).

#### Scenario: Agent attempts to call a non-declared tool

- **WHEN** an agent declares `tools: read, grep, find` and the LLM emits a `tool_call` for `mcp__flows__bash`
- **THEN** the guard extension SHALL block the call with reason `Tool "mcp__flows__bash" not declared in agent frontmatter. Declared tools: ...`
- **AND** the call SHALL NOT execute even though the SDK's tool registry contains the bash definition.

