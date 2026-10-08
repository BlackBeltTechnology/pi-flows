## Why

On `anthropic-messages` models, flow agents register their custom tools as `mcp__flows__<name>`. That prefixed name then shows up in the dashboard (`mcp__flows__rackinspect_zoom_image`), while the main chat shows the clean pi name. The prefix is now redundant: `flows-anthropic-bridge-plugin` loads `@blackbelt-technology/pi-anthropic-messages` into every flow agent via `flow:register-agent-extension`. That extension already renames tools on the wire (outbound `foo` → `mcp__pi__foo`, inbound back to `foo`). Because pi-flows renames tools at registration time instead, nothing translates them back. The name the agent actually registers is the prefixed one, and it leaks into events, tool-call records and the UI.

## What Changes

- **BREAKING**: Remove the `mcp__flows__` registration-time prefix entirely. On every provider API, flow agents register and activate tools under their plain pi names: `customTools`, extension-registered tools, `finish`, `ask_user` and allowed-tool names.
- Remove the `toolPrefix` option from the guard extension. The guard compares plain names.
- Delete `extensions/flow-engine/tool-prefix.ts` (`prefixToolName`, `CORE_TOOL_NAMES`) and the internal re-export from `execution.ts`. Neither is part of the documented public API.
- Tool names emitted through `onToolCall`/`onToolResult` and stored in `ToolCallRecord` are the plain pi names. The dashboard therefore shows `rackinspect_zoom_image`, matching the main chat.
- The faux test harness drops its prefixed-finish branch. `spawnFaux` returns `finishToolName: "finish"` for every `modelApi`.
- **BREAKING (deployment)**: Running flow agents on Anthropic's OAuth / Claude Code endpoint now requires `@blackbelt-technology/pi-anthropic-messages` to be installed. pi-flows' built-in `anthropic-messages-adapter` loads it into every agent, and the bridge plugin is optional. Without it, Anthropic rejects the request (verified by smoke test: "out of extra usage"). This goes in the README and CHANGELOG.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `subagent-spawn`: active tool set, `extraCustomTools` naming and guard sandboxing use plain pi tool names instead of `mcp__flows__`-prefixed names.
- `faux-model-testing`: the prefix-path coverage requirement becomes a requirement that `anthropic-messages` agents use the unprefixed `finish`.

## Impact

- Code: `extensions/flow-engine/execution.ts`, `extensions/flow-engine/guard.ts`, `extensions/flow-engine/tool-prefix.ts` (deleted), `extensions/flow-engine/testing.ts`.
- Tests: `__tests__/faux-spawn-prefix.test.ts`, `__tests__/pi-runtime-alignment.test.ts`.
- Docs: `extensions/flow-engine/AGENTS.md`, `docs/testing.md`, `README.md`, `CHANGELOG.md`.
- Runtime dependency (soft): Anthropic OAuth users need `pi-anthropic-messages` installed (loaded by pi-flows' own adapter; the bridge plugin is optional). Other providers are unaffected, since they never got the prefix.
- Dashboard: no code change needed. Flow tool rows show clean names automatically.

## Discipline Skills

`doubt-driven-review` (behaviour change on a cross-package boundary, before it lands).
