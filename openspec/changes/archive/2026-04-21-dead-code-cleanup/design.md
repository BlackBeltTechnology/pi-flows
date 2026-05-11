## Context

The pi-flows codebase accumulated dead code over its development history — initial-commit fossils that were never pruned as the architecture evolved, duplicate type definitions across files, and orphaned event emits/listeners. A full audit cross-referenced every export, event, tool registration, function, and type against actual usage across the entire monorepo (pi-flows, pi-agent-dashboard, pi-anthropic-messages, openspec).

All removals target code with zero runtime callers confirmed via static analysis of the complete monorepo.

## Goals / Non-Goals

**Goals:**
- Remove all confirmed-dead code (zero callers/importers across monorepo)
- Consolidate duplicate type definitions (`AccessRules`, `Diagnostic`)
- Remove orphaned event emits and deprecated event listeners
- Shrink the public export surface to match actual usage

**Non-Goals:**
- Documentation updates (events-api.md, tools-reference.md, public-api.md) — tracked separately
- Fixing or replacing the `subagent` tool with a working version — just deleting
- Removing "extension point" listeners that have no current emitters but are designed for future packages (`flow:register-card`, `flow:register-workflow`, `flow:register-tool`, etc.)
- Refactoring the query-via-event-mutation pattern (`flow:get-agents`, `flow:role-get-all`, etc.)

## Decisions

### D1: Delete `subagent` tool entirely (not fix)

**Choice**: Delete `tool.ts` and its registration.

**Rationale**: The tool has 10 distinct problems (wrong return value, no observer wiring, no signal, no extraCustomTools, etc). Fixing it would be a feature addition, not cleanup. All flow execution goes through direct `spawnAgent()` calls. The main-session LLM has no system-prompt hint about this tool, so it's never invoked in practice. pi-anthropic-messages tests reference "subagent" as a generic fixture name, not a real dependency on this tool.

**Alternative considered**: Fix the tool to return structured `finish` data + wire observers. Rejected — this is a feature decision that deserves its own proposal, not a cleanup task.

### D2: Consolidate `Diagnostic` into a shared location

**Choice**: Move `Diagnostic` interface to `extensions/flow-engine/types.ts` and import from both `agent-validate.ts` and `flow-validate.ts`.

**Rationale**: Both files define identical interfaces. `types.ts` is already the canonical location for shared types. This avoids a new file while keeping the interface co-located with other shared definitions.

**Alternative considered**: Create `extensions/flow-engine/tools/shared-types.ts`. Rejected — unnecessary file for a single interface.

### D3: Import `AccessRules` in guard.ts from types.ts

**Choice**: Delete the private `AccessRules` interface from `guard.ts`, import from `types.ts`.

**Rationale**: Identical definitions. `types.ts` already exports it and `agent-parser.ts` imports it from there. Single source of truth.

### D4: Keep `SubagentEvent` base type in types.ts but remove from index.ts re-exports

**Choice**: Keep the base `SubagentEvent` interface definition (it's the parent type for the event data shapes) but remove it from the public export surface in `index.ts`. Delete the 4 specialized subtypes (`SubagentStartedEvent`, `SubagentCompleteEvent`, `SubagentToolCallEvent`, `SubagentToolResultEvent`) and `SubagentEventType` — all have zero references.

**Rationale**: `SubagentEvent` is referenced in `index.ts` re-exports and `public-api.md` but has zero actual external consumers. The subtypes are completely dead. Keeping the base in types.ts is harmless; removing the re-export is the meaningful change.

### D5: Remove `flow:delete-result` emits (not add listener)

**Choice**: Remove the 3 `flow:delete-result` emit calls from `flow-context/index.ts`.

**Rationale**: The `flow:delete-request` listener handles deletion and could return status directly to its caller. The result event has zero listeners anywhere. If a dashboard bridge needs deletion status in the future, it should be added intentionally with a proper listener.

## Risks / Trade-offs

- **[Risk] External consumers import removed exports** → Mitigated: grep of entire monorepo confirms zero external imports. Published package consumers could theoretically import them, but these are undocumented internal APIs with zero usage signals.
- **[Risk] `SubagentEvent` removal from exports breaks dashboard typing** → Mitigated: pi-agent-dashboard defines its own event types and only couples through the event bus, not type imports.
- **[Risk] `flow:delete-result` removal hides deletion failures** → Mitigated: the `flow:delete-request` handler already returns results synchronously via event-bus mutation pattern. If async notification is needed later, add it intentionally.
