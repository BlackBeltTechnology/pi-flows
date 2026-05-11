## 1. Delete subagent tool

- [x] 1.1 Delete `extensions/flow-engine/tool.ts` entirely
- [x] 1.2 Remove `import { registerSubagentTool } from "./tool.js"` from `extensions/flow-engine/index.ts`
- [x] 1.3 Remove the `registerSubagentTool(...)` call block (index.ts ~lines 323-330)
- [x] 1.4 Remove `import { spawnAgent } from "./execution.js"` from tool.ts (gone with file)

## 2. Remove dead functions and exports

- [x] 2.1 Delete `getLastResultOutput()` function from `extensions/flow-engine/flow-execution.ts` (line 925-928)
- [x] 2.2 Delete `isAnthropicOAuthToken()` export from `extensions/flow-engine/tool-prefix.ts` (lines 40-46)
- [x] 2.3 Delete `hasStagingDir()` export from `extensions/flow-workspace/staging.ts` (line 40-44)
- [x] 2.4 Delete `textInputSubmenu()` export from `extensions/shared/overlays.ts` (line 424+)
- [x] 2.5 Remove `export` keyword from `padLine` in `extensions/flow-dashboard/box-renderer.ts` (make it module-private)
- [x] 2.6 Remove `export` keyword from `computeStats()` in `extensions/flow-summary/index.ts` (made module-private; verified it IS called internally on line 87)
- [x] 2.7 Remove `export type SummaryMode` from `extensions/flow-summary/index.ts` (line 9; made module-private, used internally on line 24)

## 3. Remove dead types from types.ts

- [x] 3.1 Delete `StepRouting` interface from `extensions/flow-engine/types.ts` (line 137-140)
- [x] 3.2 Delete `SubagentEventType` type alias from `extensions/flow-engine/types.ts` (line 188-192)
- [x] 3.3 Delete `SubagentStartedEvent` interface (line 196-199)
- [x] 3.4 Delete `SubagentCompleteEvent` interface (line 201-204)
- [x] 3.5 Delete `SubagentToolCallEvent` interface (line 206-209)
- [x] 3.6 Delete `SubagentToolResultEvent` interface (line 211-215)
- [x] 3.7 Remove `SubagentEvent` from the `export type { ... }` block in `extensions/flow-engine/index.ts` (line 41)

## 4. Consolidate duplicate types

- [x] 4.1 Move `Diagnostic` interface to `extensions/flow-engine/types.ts` (add export)
- [x] 4.2 Update `extensions/flow-engine/tools/agent-validate.ts` to import `Diagnostic` from `../types.js` and delete the local definition
- [x] 4.3 Update `extensions/flow-engine/tools/flow-validate.ts` to import `Diagnostic` from `../types.js` and delete the local definition
- [x] 4.4 In `extensions/flow-engine/guard.ts`: delete the private `AccessRules` interface (line 16-20), add `import type { AccessRules } from "./types.js"`

## 5. Remove orphaned events and deprecated listeners

- [x] 5.1 Remove all 3 `pi.events.emit("flow:delete-result", ...)` calls from `extensions/flow-context/index.ts` (lines ~139, ~146, ~151)
- [x] 5.2 Remove the `pi.events?.on("flow:register-guard-extension", handleRegisterAgentExtension)` listener from `extensions/flow-engine/index.ts` (line ~319)

## 6. Clean up index.ts re-exports

- [x] 6.1 Remove `parseAgentString` from the re-export line in `extensions/flow-engine/index.ts` (line 51: change to `export { parseAgentFile } from "./agent-parser.js"`)

## 7. Verify

- [x] 7.1 Run `grep -rn "registerSubagentTool\|getLastResultOutput\|isAnthropicOAuthToken\|hasStagingDir\|textInputSubmenu\|StepRouting\|SubagentStartedEvent\|SubagentCompleteEvent\|SubagentToolCallEvent\|SubagentToolResultEvent\|SubagentEventType\|flow:delete-result\|flow:register-guard-extension\|parseAgentString" extensions/ --include='*.ts'` — zero hits for removed items confirmed; parseAgentString only in agent-parser.ts definition
- [x] 7.2 Verified all remaining `import` statements in modified files resolve correctly (guard.ts, agent-validate.ts, flow-validate.ts, index.ts, flow-context/index.ts)
