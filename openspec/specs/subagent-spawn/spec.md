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

### Requirement: spawnAgent activates the correct tool set after bindExtensions

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

#### Scenario: Active tool list includes unprefixed customTools

- **WHEN** `spawnAgent` activates tools for the flow architect (which receives `agent_catalog`, `agent_write`, `flow_write` via `extraCustomTools`) on `anthropic-messages`
- **THEN** `setActiveToolsByName` SHALL include `agent_catalog`, `agent_write`, `flow_write` unchanged.

#### Scenario: Reported tool calls carry plain names

- **WHEN** a flow agent on `anthropic-messages` calls the custom tool `rackinspect_zoom_image`
- **THEN** the `onToolCall` callback and the recorded `ToolCallRecord.toolName` SHALL be `rackinspect_zoom_image`.

### Requirement: extraCustomTools are passed as ToolDefinition objects, with unchanged names

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

### Requirement: spawnAgent supplies a complete ResourceLoader to createAgentSession

When `spawnAgent` constructs a subagent session, the `ResourceLoader` it passes to
`createAgentSession` SHALL implement the full loader interface required by the
current pi SDK, including the system-prompt-source accessors
`getSystemPromptSource()` and `getAppendSystemPromptSources()`.

Because `spawnAgent` composes the agent's system prompt in memory (no on-disk
prompt file backs it), these accessors SHALL report the absence of a source:
`getSystemPromptSource()` SHALL return `undefined`, and
`getAppendSystemPromptSources()` SHALL return an empty array. The existing
prompt-composition behaviour is preserved: `getSystemPrompt()` returns `undefined`
so the SDK builds its default system prompt, and `getAppendSystemPrompt()` returns
the agent-specific prompt to append.

#### Scenario: ResourceLoader implements the system-prompt-source accessors

- **WHEN** `spawnAgent` builds the `ResourceLoader` for a subagent session
- **THEN** the loader SHALL expose `getSystemPromptSource()` returning `undefined`
- **AND** the loader SHALL expose `getAppendSystemPromptSources()` returning `[]`
- **AND** `createAgentSession` SHALL construct the session without throwing on a
  missing loader method.

#### Scenario: Append-prompt composition is unchanged

- **WHEN** `spawnAgent` has composed an agent-specific system prompt
- **THEN** `getAppendSystemPrompt()` SHALL return that prompt as a single-element array
- **AND** `getSystemPrompt()` SHALL return `undefined` so the SDK still emits its
  default system prompt with tool descriptions.

### Requirement: spawnAgent supplies model/auth via the modelRuntime option

`spawnAgent` SHALL provide session model/auth to `createAgentSession` through the
SDK's `modelRuntime` option. It SHALL NOT pass the removed `authStorage` or
`modelRegistry` session-bootstrap options, and SHALL NOT import the removed
`AuthStorage` type from the pi SDK.

When a flow runs inside a pi session, the runtime supplied to every agent session
it spawns (agent steps, autonomous fork-decision agents, and `agent-decision`
agents including loop iterations) SHALL be the parent session's own model runtime: the same
providers and API keys, including providers registered at runtime via
`pi.registerProvider()`. When no parent runtime is available (programmatic run
without a session), the option SHALL be omitted so the SDK builds its default
runtime.

Only providers and credentials are shared. The agent's model SHALL NOT be inherited
from the parent session: it SHALL come solely from the agent's own `model:`
reference via model resolution, and an agent whose model is missing or cannot be
resolved SHALL still fail. The model-role resolution path (which reads
`pi.modelRegistry`) is unaffected by this requirement.

#### Scenario: Bootstrap uses modelRuntime, not the removed options

- **WHEN** `spawnAgent` calls `createAgentSession`
- **THEN** the options object SHALL NOT contain an `authStorage` key
- **AND** the options object SHALL NOT contain a `modelRegistry` key
- **AND** model/auth SHALL be supplied via `modelRuntime` when one is available.

#### Scenario: Faux spawn constructs and completes under the current runtime

- **WHEN** a faux, zero-network agent is spawned via the real `spawnAgent` loop and
  scripted to finish successfully
- **THEN** the session SHALL be constructed without error
- **AND** the resulting agent outcome SHALL report success (not a session-creation
  error).

#### Scenario: Runtime-registered provider is usable by a flow agent

- **GIVEN** a parent session whose real model registry has a provider registered at
  runtime via `registerProvider` (with an API key) that does not exist in
  `models.json` or `auth.json`
- **WHEN** a flow agent whose `model:` names a model of that provider is spawned
- **THEN** the agent session SHALL resolve that provider and its API key from the
  parent runtime
- **AND** the first request SHALL NOT fail with "No API key found" or "Unknown
  provider".

#### Scenario: Provider registered after session start is visible

- **GIVEN** a provider is registered on the parent runtime after the session started
- **WHEN** a flow agent using that provider's model is spawned
- **THEN** the agent session SHALL resolve that provider and its API key.

#### Scenario: A new session replaces the captured runtime

- **WHEN** a new parent session starts in the same process
- **THEN** subsequently spawned flow agents SHALL use the new session's runtime and SHALL NOT use the previous one.

#### Scenario: Every agent-spawning step kind receives the same runtime

- **WHEN** a flow spawns agents via an agent step, an autonomous fork decision, and an
  `agent-decision` step that loops back at least once
- **THEN** every one of those agent sessions SHALL receive the same parent model runtime.

#### Scenario: Model is never inherited from the parent

- **GIVEN** the parent session's current model is `X`
- **WHEN** an agent with no resolvable `model:` (missing or unknown ref) is spawned
- **THEN** the agent invocation SHALL fail with a model-resolution error
- **AND** it SHALL NOT fall back to model `X`.

#### Scenario: No parent runtime falls back to the default runtime

- **WHEN** a flow is run programmatically without a parent session runtime
- **THEN** `createAgentSession` SHALL be called without a `modelRuntime` key.

### Requirement: Tool results are attributed to their own tool call

When an agent makes several tool calls in one assistant turn, `spawnAgent` SHALL attribute each tool's result, error flag and reported name to the record of the call with the same tool-call id, regardless of the order in which the calls finish.

#### Scenario: Parallel tool calls keep their own results

- **WHEN** the model emits `tool_a` and `tool_b` in one assistant turn
- **THEN** the `tool_a` record SHALL hold `tool_a`'s output and error flag, and the `tool_b` record SHALL hold `tool_b`'s
- **AND** `onToolResult` SHALL be called with each tool's own name and output.
