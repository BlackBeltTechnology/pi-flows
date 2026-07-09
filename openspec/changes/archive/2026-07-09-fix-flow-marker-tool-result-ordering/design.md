## Context

`FlowEventPersister` (`extensions/flow-engine/flow-persist.ts`) appends a non-empty assistant "marker" (`[flow] <name> started` / `finished`) via `SessionManager.appendMessage` to open pi's sticky `hasAssistant` flush gate, so a headless flow-only session's `flow-event` custom entries reach disk for `/resume` and reload survival.

`SessionManager` threads every entry into a parent tree: each `appendMessage`/`appendCustomEntry` stamps `parentId = leafId` then advances `leafId`. `buildSessionContext` walks leaf→root, dropping `custom` entries (not in LLM context) but keeping real `message` entries — including the marker.

When a flow is launched from inside a tool call, the launching assistant `tool_use` is recorded but its `tool_result` is not yet appended (the tool awaits the flow). The start marker appended in that window becomes an ancestor of the eventual `tool_result` and a descendant of the `tool_use`, so the rebuilt message list is `[… assistant(tool_use), assistant(marker), toolResult …]`. Anthropic rejects the `tool_result` whose previous message is the marker: `400 unexpected tool_use_id … must have a corresponding tool_use block in the previous message`. A scan of 1021 local sessions reproduced this in 5 sessions / 20 pairs; sessions launching flows outside a tool boundary had zero corruption.

## Goals / Non-Goals

**Goals:**
- Prevent the marker from splicing between a `tool_use` and its `tool_result`.
- Preserve the marker's sole real purpose: opening the flush gate (and reporting completion) for headless flow-only sessions.
- Keep the fix inside pi-flows (`flow-persist.ts`), no pi-core change, no protocol change.

**Non-Goals:**
- Repairing already-corrupted session logs (source-side prevention only; reader-side repair in pi core is a possible follow-up).
- The user-interrupt race (a `user` message arriving mid-tool-call), which is a separate defect.

## Decisions

### Decision: Gate the marker on "session has no user message"

Append a lifecycle marker only when the session contains no `message` with role `user`. Implement in `appendMarker` (single choke point for both `emitStartMarker` and `emitCompletionMarker`) by inspecting the captured `SessionManager` via `getEntries()`/`getBranch()`.

**Why this predicate.** Classifying every `[flow] … started` marker across 1021 sessions:

| predecessor state | count | meaning |
|---|---|---|
| session root (no user/assistant) | 935 | headless flow-only — needs marker, safe boundary |
| after assistant `tool_use` | 20 | the corruption (5 sessions) |
| after resolved assistant | 25 | interactive, gate already open |
| after `tool_result` | 2 | interactive, gate already open |
| after user, no assistant yet | **0** | the only regression case — never occurs |

"No user message" ⟺ headless flow-only ⟺ marker needed + appended at session root (never mid-tool-call). "Has user message" ⟺ interactive/managed ⟺ a real assistant turn already opened the gate ⟺ marker redundant → skip. The empty `after user, no assistant` bucket proves zero regression.

**Alternatives considered:**
- *Skip when `hasAssistant`* (any assistant message exists): rejected. The START marker itself creates an assistant message, so `hasAssistant` flips true and the COMPLETION marker would be wrongly suppressed in a headless run — losing the automation completion signal. "No user message" does not flip on the start marker (it creates an assistant, not a user, message), so both markers still fire headless.
- *Skip only when the leaf is an unresolved assistant `tool_use`* (minimal corruption guard): correct for the 20 corruption pairs but more complex (must inspect leaf content shape) and still appends redundant markers in the 27 already-gate-open interactive cases. "No user message" is simpler and strictly cleaner.
- *Reader-side coalescing in `buildSessionContext`* (pi core): repairs existing logs too, but is a pi-core change outside this package's scope; can follow later.

## Risks / Trade-offs

- [A managed/automation flow that seeds a `user` message but never runs a model turn would be skipped and never open the gate] → Not observed in 1021 sessions (`after user, no assistant` = 0). If such a launch path is later added, it must open the gate explicitly (e.g. a dedicated headless launch that appends the marker before any user message, or a pi-core custom-entry persistence primitive).
- [Losing the marker as LLM-visible flow-status context in interactive sessions] → Acceptable: the launching tool's own `tool_result` already carries flow status to the managing model.

## Migration Plan

Pure behavioral fix in `appendMarker`. No data migration. Rollback = revert the guard. Existing corrupted logs remain corrupted (out of scope).

## Open Questions

None.
