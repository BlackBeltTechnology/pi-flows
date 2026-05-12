# Fix subagent tool injection — pass tool names, not definition objects

## Why

The flow architect (and any other flow subagent) hit the LLM with **no `tools` array on the wire**. The architect's system prompt literally said `Available tools: (none)` and the model refused to call any tool — including `mcp__flows__finish`, which is required for the agent to ever complete. Every `/flows:new` failed.

Captured payload from `/tmp/pi-am.log`:
```json
{
  "model": "claude-sonnet-4-6",
  "messages": [...],
  "max_tokens": 32000,
  "stream": true,
  "system": [...]      // "Available tools: (none)"
  // tools[] field absent
}
```

Root cause is in `extensions/flow-engine/execution.ts`'s `spawnAgent`. The code passed **tool definition objects** to `createAgentSession({ tools })`, but pi-coding-agent's `tools` option is a **string array of tool NAMES** that selects from its built-in registry:

```ts
// pi-coding-agent/dist/core/sdk.js:152
const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
const initialActiveToolNames = options.tools
    ? [...options.tools]
    : options.noTools ? [] : defaultActiveToolNames;
```

Passing objects silently turned `allowedToolNames` into a Set of `[object Object]` strings that never matched real tool names. Then `_refreshToolRegistry` filtered the entire registry against this set:

```ts
const allCustomTools = [...registeredTools, ...customTools]
    .filter((tool) => isAllowedTool(tool.definition.name));   // returns false for every name
```

So every tool — agent.tools[] declarations, `extraCustomTools` (agent_catalog, agent_write, flow_write), and the guard's `finish` — got filtered out. The session ended up with zero tools, no `tools` array on the wire, and the model panicked.

## What changes

Three coordinated changes in `extensions/flow-engine/execution.ts`:

1. **Build `builtinToolNames` as a `string[]`** of lowercase pi tool names (`["read", "grep", "find"]`), filtered to those present in `TOOL_FACTORIES`. The SDK looks tools up by lowercase pi names; canonical capitalization and `mcp__` prefixing for Claude-model anthropic-messages happens later in pi-ai or `@pi/anthropic-messages`.

2. **Pass `tools: undefined` to `createAgentSession`.** With `allowedToolNames` undefined, the SDK applies no filter and every registered tool (built-ins + `customTools` + the guard's `finish`) lands in `_toolRegistry`. The subagent sandbox is enforced by the guard extension's `tool_call` blocker, not by the SDK's name allowlist.

3. **After `session.bindExtensions(...)`, call `session.setActiveToolsByName(...)`** with the **prefixed** names of every tool the agent should expose: prefixed built-ins, all `customTools` (already prefixed during the map), and the guard's prefixed `finish`. This rebuilds the system prompt and wire `tools[]` array correctly.

Add a new `subagent-spawn` spec capturing this contract so the SDK's name-vs-object distinction doesn't regress.

## Impact

- **Affected specs:** new `subagent-spawn` capability.
- **Affected code:** `extensions/flow-engine/execution.ts:spawnAgent` only.
- **Affected consumers:** every flow subagent — architect, agent-step, fork-decision-agent, agent-decision, agent-loop-decision, flow-workspace's edit/new architect spawns.
- **Backward compatibility:** strictly fixes the bug. Existing flow specs and agent declarations are unchanged.
- **Test verification:** running `/flows:new` produces a working architect subagent whose outbound payload contains a non-empty `tools[]` array. `/tmp/pi-am.log` shows the architect calling `mcp__flows__finish` successfully.
