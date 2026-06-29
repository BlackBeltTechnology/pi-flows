# Tasks

- [x] 1. `extensions/flow-engine/execution.ts`: replace the tool-objects-as-`tools` pattern with the SDK's expected contract.
  - Build `builtinToolNames: string[]` from `agent.tools.filter(t => TOOL_FACTORIES[t])`.
  - Keep `customTools` as ToolDefinition objects (prefixed for anthropic-messages).
  - Pass `tools: undefined` to `createAgentSession` so SDK does not filter the registry.
- [x] 2. After `session.bindExtensions(...)`, call `session.setActiveToolsByName(allActiveNames)` with prefixed built-ins, customTools, and finish.
- [ ] 3. Add `subagent-spawn` spec (see `specs/subagent-spawn/spec.md`) locking the contract.
- [ ] 4. Add a unit test under `__tests__/spawn-agent.test.ts` that:
   - Mocks `createAgentSession` to capture the `tools` and `customTools` arguments.
   - Asserts `tools` is `undefined`.
   - Asserts `customTools` is a non-empty array of ToolDefinition objects with prefixed names.
   - Asserts `setActiveToolsByName` is called with the expected name list.
- [ ] 5. End-to-end verification:
   - Truncate `/tmp/pi-am.log`, restart dashboard server, reload pi sessions.
   - Run `/flows:new` against a Claude anthropic-messages session.
   - Confirm `tools[]` array in outbound payload contains `Read`, `Grep`, `Find`, `mcp__flows__finish`, `mcp__flows__agent_catalog`, `mcp__flows__agent_write`, `mcp__flows__flow_write`.
   - Confirm architect successfully calls `mcp__flows__finish`.
- [ ] 6. Bump pi-flows to `0.1.3`, note in CHANGELOG.
- [ ] 7. Update `docs/architecture.md` "subagent spawn" section if it documents the old wrong contract.
