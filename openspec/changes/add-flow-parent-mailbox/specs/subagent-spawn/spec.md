# Spec Delta

## MODIFIED Requirements

### Requirement: Subagent sandbox uses guard extension, not SDK allowlist

The subagent's tool sandbox (which tools the agent may call) SHALL be enforced by the guard extension's `tool_call` event blocker, NOT by the SDK's `allowedToolNames` filter. This is because passing `tools: undefined` disables the SDK filter (Requirement above).

The guard extension SHALL block any `tool_call` event whose `toolName` is not in `[...agent.tools, "finish"]`, compared by plain pi tool name, except tools the engine injects for the run's worker agents (`ask_parent` in a parent-attached run), which SHALL NOT be blocked. It SHALL block `ask_user` by its plain name unless explicitly allowed.

#### Scenario: Agent attempts to call a non-declared tool

- **WHEN** an agent declares `tools: read, grep, find` and the LLM emits a `tool_call` for `bash`
- **THEN** the guard extension SHALL block the call with reason `Tool "bash" not declared in agent frontmatter. Declared tools: ...`
- **AND** the call SHALL NOT execute even though the SDK's tool registry contains the bash definition.

#### Scenario: Declared custom tool is allowed on anthropic-messages

- **WHEN** an agent on `anthropic-messages` declares `tools: rackinspect_zoom_image` and the LLM emits a `tool_call` for `rackinspect_zoom_image`
- **THEN** the guard extension SHALL NOT block the call.

#### Scenario: Injected ask_parent passes an allowlist

- **WHEN** a worker agent of a parent-attached run declares `tools: read` and the LLM emits a `tool_call` for `ask_parent`
- **THEN** the guard extension SHALL NOT block the call.

#### Scenario: One ask_parent definition per session

- **WHEN** a main-session extension tool named `ask_parent` is also offered to a worker agent of a parent-attached run
- **THEN** the agent's session SHALL contain only the engine's `ask_parent`
