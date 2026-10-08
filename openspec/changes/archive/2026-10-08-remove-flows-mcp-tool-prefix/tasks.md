## 1. Failing tests first

- [x] 1.1 Rewrite `__tests__/faux-spawn-prefix.test.ts` (rename it to `faux-spawn-anthropic-names.test.ts`). With `modelApi: "anthropic-messages"`, scripting `finish` completes the agent and `finishToolName === "finish"`; scripting `mcp__flows__finish` does NOT complete it. Verify: `npx vitest run __tests__/faux-spawn-anthropic-names.test.ts` fails against current code.
- [x] 1.2 Add a faux test: an `anthropic-messages` agent with an `extraCustomTools` entry `my_tool` (declared in `tools`) calls `my_tool`. Assert that `onToolCall` and `result.toolCalls[].toolName` are `my_tool` and that the guard does not block the call. Verify: the test fails against current code.
- [x] 1.3 Add a faux test: an agent extension factory that calls `registerTool({ name: "ext_tool" })` on `anthropic-messages` registers `ext_tool` unprefixed and the agent can call it. Verify: the test fails against current code.
- [x] 1.4 Update `__tests__/pi-runtime-alignment.test.ts` so the anthropic-messages case scripts `finish`. Verify: it fails against current code.

## 2. Remove the prefix

- [x] 2.1 In `extensions/flow-engine/execution.ts`, remove `toolPrefix` detection, the `customTools` prefix map, the `buildExtensionFromFactory` `toolPrefix` param and its `registerTool` prefixing, prefixing in `activeToolNames`/`finishToolName`, the `prefixToolName` import and re-export, and the stale comments that mention `mcp__flows__`. Verify: `rg "mcp__flows__|prefixToolName|toolPrefix" extensions/flow-engine/execution.ts` returns nothing.
- [x] 2.2 In `extensions/flow-engine/guard.ts`, remove the `toolPrefix` option and the `prefixToolName` import, and use plain `finish`, `ask_user` and `allowedTools`. Verify: `rg "toolPrefix|prefixToolName" extensions/flow-engine/guard.ts` returns nothing.
- [x] 2.3 Delete `extensions/flow-engine/tool-prefix.ts`. Verify: `rg "tool-prefix" extensions __tests__` returns nothing.
- [x] 2.5 Fix a bug that predates this change, found by 1.3: include extension-registered tools that the agent declares in `tools` in `setActiveToolsByName`, and leave undeclared ones out. Verify: test 1.3 passes, and a new test shows an undeclared extension tool is not activated.
- [x] 2.6 Fix a bug that predates this change, found by spike: with parallel tool calls, `tool_execution_end` writes results onto the last record. Match by `toolCallId` instead. Verify: a new parallel-call faux test passes and fails without the fix.
- [x] 2.4 In `extensions/flow-engine/testing.ts`, return `finishToolName = "finish"` unconditionally and update the `modelApi` comments. Verify: all tests from group 1 pass.

## 3. Docs

- [x] 3.1 Update `extensions/flow-engine/AGENTS.md`: remove the `tool-prefix.ts` row and drop "prefixed" from the `guard.ts` row. Verify: `rg "mcp__flows__|tool-prefix" extensions/flow-engine/AGENTS.md` returns nothing.
- [x] 3.2 Update `docs/testing.md` (delegated to a general-purpose subagent, per AGENTS.md) to remove the `mcp__flows__` prefix-path text and state that `finishToolName` is always `finish`. Verify: `rg "mcp__flows__" docs/` returns nothing.
- [x] 3.3 In `README.md`, document that flow agents on Anthropic OAuth require `pi-anthropic-messages` + `flows-anthropic-bridge-plugin` for wire tool renaming. Verify: the section exists.
- [x] 3.4 Add a **BREAKING** entry to `CHANGELOG.md` covering the prefix removal and the new OAuth requirement. Verify: the entry exists under Unreleased.

## 4. Gates

- [x] 4.1 Run `npm run lint && npm run typecheck && npm test`. Verify: all green, and `rg "mcp__flows__" extensions __tests__` returns nothing.
- [x] 4.2 Live smoke test (`pi --mode rpc`, Anthropic OAuth, claude-haiku-4-5; harness in /tmp/pf-smoke). New code: wire shows `mcp__pi__rackinspect_zoom_image`, and `flow:subagent-tool-call`/`-result` show `rackinspect_zoom_image` → `ZOOMED:A1`, flow succeeds. Old code (stashed): events show `mcp__flows__rackinspect_zoom_image` (bug reproduced). Without the bridge: still passes (pi-flows' own adapter loads the renamer). With the renamer unresolvable: Anthropic rejects ("out of extra usage").
