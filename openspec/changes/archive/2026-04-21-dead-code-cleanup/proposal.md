## Why

A comprehensive audit of the pi-flows codebase revealed accumulated dead code, unused exports, orphaned events, duplicate type definitions, and documentation drift. These fossils increase cognitive load, mislead contributors, and create a false sense of API surface. Cleaning them up now prevents further drift and makes the codebase honest about what's actually used.

## What Changes

- **Remove dead tool**: Delete the `subagent` tool registration (`tool.ts`) — it's registered on the main session but never invoked by any flow execution path, returns wrong data (`result.output` instead of structured `finish` payload), and lacks half the parameters `spawnAgent()` supports.
- **Remove dead functions**: `getLastResultOutput()` in `flow-execution.ts` (zero callers), `isAnthropicOAuthToken()` in `tool-prefix.ts` (exported, never imported).
- **Remove dead exports**: `hasStagingDir()` from `staging.ts`, `textInputSubmenu()` from `overlays.ts`, `computeStats()` and `SummaryMode` from `flow-summary/index.ts`, `padLine` from `box-renderer.ts`.
- **Remove dead types**: `StepRouting`, `SubagentStartedEvent`, `SubagentCompleteEvent`, `SubagentToolCallEvent`, `SubagentToolResultEvent`, `SubagentEventType` from `types.ts`. Un-export `SubagentEvent` from `index.ts` (zero external consumers).
- **Consolidate duplicates**: `AccessRules` (defined identically in `guard.ts` and `types.ts`) — guard.ts should import from types.ts. `Diagnostic` (defined identically in `agent-validate.ts` and `flow-validate.ts`) — extract to shared location.
- **Remove orphaned event**: `flow:delete-result` is emitted 3 times in `flow-context/index.ts` but nothing listens. Remove the emits.
- **Remove deprecated event alias**: `flow:register-guard-extension` listener (commented as deprecated, zero emitters).
- **Un-export unused re-exports**: Remove `parseAgentString` from `index.ts` re-exports (only used internally by `parseAgentFile`).

## Capabilities

### New Capabilities

_(none — this is a removal-only change)_

### Modified Capabilities

_(no spec-level behavior changes — all removals are of dead/unreachable code)_

## Impact

- **extensions/flow-engine/tool.ts**: Entire file deleted, import + call removed from `index.ts`.
- **extensions/flow-engine/index.ts**: Fewer re-exports (`SubagentEvent`, `parseAgentString` removed from export surface).
- **extensions/flow-engine/types.ts**: 6 interfaces/types removed.
- **extensions/flow-engine/flow-execution.ts**: 1 dead function removed.
- **extensions/flow-engine/tool-prefix.ts**: 1 dead export removed.
- **extensions/flow-engine/guard.ts**: Private `AccessRules` replaced with import from `types.ts`.
- **extensions/flow-engine/tools/agent-validate.ts** + **flow-validate.ts**: Duplicate `Diagnostic` consolidated.
- **extensions/flow-workspace/staging.ts**: 1 dead export removed.
- **extensions/shared/overlays.ts**: 1 dead export removed.
- **extensions/flow-summary/index.ts**: 2 dead exports removed.
- **extensions/flow-dashboard/box-renderer.ts**: `padLine` un-exported.
- **extensions/flow-context/index.ts**: 3 orphaned event emits removed.
- **extensions/flow-engine/index.ts**: Deprecated `flow:register-guard-extension` listener removed.
- **No cross-package breakage**: Confirmed zero imports of any removed symbol from sibling packages (`pi-agent-dashboard`, `pi-anthropic-messages`, `openspec`).
