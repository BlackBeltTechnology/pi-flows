## MODIFIED Requirements

### Requirement: spawnAgent activates the correct prefixed tool set after bindExtensions

After `session.bindExtensions(...)` returns, `spawnAgent` SHALL call `session.setActiveToolsByName(...)` with the array of names the agent should expose. The array SHALL include, under their plain pi names regardless of the model's provider API:

1. The agent's declared built-in pi tool names (e.g. `read`, `bash`, `grep`).
2. Every entry from `customTools`, under its original name.
3. Every tool registered by an agent extension (`extraAgentExtensions`, e.g. via `registerTool`) whose name the agent declares in `tools`.
4. The guard extension's `finish` tool.

`spawnAgent` SHALL NOT add any `mcp__` prefix to tool names. Any wire-level renaming that a provider endpoint requires (e.g. Anthropic's OAuth allowlist) is the responsibility of a provider extension loaded into the agent, not of pi-flows.

Calling `setActiveToolsByName` MUST happen AFTER `bindExtensions` because the guard's `finish` tool registers itself into the session's tool registry during bind.

#### Scenario: Active tool list includes the guard's finish

- **WHEN** `spawnAgent` activates tools for a flow agent running on `anthropic-messages`
- **THEN** `setActiveToolsByName` SHALL be called with an array that includes `finish`
- **AND** the array SHALL NOT contain any name starting with `mcp__flows__`.

#### Scenario: Active tool list includes prefixed customTools

- **WHEN** `spawnAgent` activates tools for the flow architect (which receives `agent_catalog`, `agent_write`, `flow_write` via `extraCustomTools`) on `anthropic-messages`
- **THEN** `setActiveToolsByName` SHALL include `agent_catalog`, `agent_write`, `flow_write` unchanged.

#### Scenario: Reported tool calls carry plain names

- **WHEN** a flow agent on `anthropic-messages` calls the custom tool `rackinspect_zoom_image`
- **THEN** the `onToolCall` callback and the recorded `ToolCallRecord.toolName` SHALL be `rackinspect_zoom_image`.

### Requirement: extraCustomTools are passed as ToolDefinition objects, with prefixed names

`spawnAgent` SHALL forward `options.extraCustomTools` (an array of ToolDefinition objects with `.execute()`) to `createAgentSession({ customTools })` with each tool's `name` unchanged, for every provider API.

The SDK adds these to `_toolRegistry` independently of the `allowedToolNames` filter, so they reach the wire regardless of whether `tools` is set or `undefined`.

#### Scenario: customTools survive the SDK registry build

- **WHEN** `spawnAgent` passes `customTools: [{name: "agent_catalog", execute, parameters, ...}, ...]`
- **THEN** the resulting `AgentSession._toolRegistry` SHALL contain an `agent_catalog` entry with the executable definition
- **AND** when `setActiveToolsByName` includes that name, the outbound payload `tools[]` SHALL include that tool.

#### Scenario: Extension-registered tools keep their names

- **WHEN** an agent extension factory calls `registerTool({ name: "my_tool", ... })` for an agent on `anthropic-messages`
- **THEN** the tool SHALL be registered in the agent session as `my_tool`.

#### Scenario: Declared extension-registered tools are callable

- **WHEN** an agent declares `tools: ext_tool` and an agent extension registers `ext_tool`
- **THEN** `ext_tool` SHALL be in the active tool set and a call to it SHALL execute (not fail with "Tool ext_tool not found")
- **AND** an extension-registered tool the agent does NOT declare SHALL NOT be activated.

### Requirement: Subagent sandbox uses guard extension, not SDK allowlist

The subagent's tool sandbox (which tools the agent may call) SHALL be enforced by the guard extension's `tool_call` event blocker, NOT by the SDK's `allowedToolNames` filter. This is because passing `tools: undefined` disables the SDK filter (Requirement above).

The guard extension SHALL block any `tool_call` event whose `toolName` is not in `[...agent.tools, "finish"]`, compared by plain pi tool name. It SHALL block `ask_user` by its plain name unless explicitly allowed.

#### Scenario: Agent attempts to call a non-declared tool

- **WHEN** an agent declares `tools: read, grep, find` and the LLM emits a `tool_call` for `bash`
- **THEN** the guard extension SHALL block the call with reason `Tool "bash" not declared in agent frontmatter. Declared tools: ...`
- **AND** the call SHALL NOT execute even though the SDK's tool registry contains the bash definition.

#### Scenario: Declared custom tool is allowed on anthropic-messages

- **WHEN** an agent on `anthropic-messages` declares `tools: rackinspect_zoom_image` and the LLM emits a `tool_call` for `rackinspect_zoom_image`
- **THEN** the guard extension SHALL NOT block the call.

## ADDED Requirements

### Requirement: Tool results are attributed to their own tool call

When an agent makes several tool calls in one assistant turn, `spawnAgent` SHALL attribute each tool's result, error flag and reported name to the record of the call with the same tool-call id, regardless of the order in which the calls finish.

#### Scenario: Parallel tool calls keep their own results

- **WHEN** the model emits `tool_a` and `tool_b` in one assistant turn
- **THEN** the `tool_a` record SHALL hold `tool_a`'s output and error flag, and the `tool_b` record SHALL hold `tool_b`'s
- **AND** `onToolResult` SHALL be called with each tool's own name and output.
