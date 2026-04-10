# Tools Reference

This document lists the tools registered by pi-flows, categorized by execution context.

## Main Session Tools

These tools are available in the main interactive session.

### `flow_results`
Retrieves the results of previously executed flows.

**Parameters:**
- `runId` (string, optional): The specific run ID to fetch.
- `limit` (number, optional): Max number of results to return.

**Returns:**
Array of flow result objects.

### `spawn_flow_architect`
Spawns the Flow Architect agent to help create or modify flows and agents.

**Parameters:**
- `prompt` (string): Instructions for the Architect.

**Returns:**
Status message indicating the Architect has been spawned.

## Agent Subprocess Tools

These tools are injected into agent subprocesses during flow execution.

### `get_step_input`
Retrieves the input data provided to the current step. Auto-injected.

**Parameters:** None

**Returns:**
The input data object for the step.

### `set_step_output`
Sets the output data for the current step, which can be passed to subsequent steps. Auto-injected.

**Parameters:**
- `data` (object): The structured output data.
- `summary` (string): A human-readable summary of the output.

**Returns:** Success boolean.

### `delegate_task`
Delegates a sub-task to another agent (if configured).

**Parameters:**
- `agentId` (string): The ID of the agent to delegate to.
- `input` (object): The input data for the sub-task.

**Returns:**
The result from the delegated agent.

## Architect-Only Tools

These tools are specific to the Flow Architect for scaffolding and managing workspace elements.

### `create_agent`
Creates a new agent `.md` file.

**Parameters:**
- `id` (string): Agent ID.
- `description` (string): Agent description.
- `systemPrompt` (string): The agent's system instructions.
- `tools` (string[]): List of tool names the agent needs.

**Returns:** Success boolean.

### `create_flow`
Creates a new flow `.yaml` file.

**Parameters:**
- `id` (string): Flow ID.
- `name` (string): Human-readable name.
- `steps` (object[]): The flow steps definition.

**Returns:** Success boolean.

### `validate_flow`
Validates a flow definition against the schema and checks for cycles.

**Parameters:**
- `path` (string): Path to the flow YAML.

**Returns:** Validation result object.
