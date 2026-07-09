## 1. Guard the marker (TDD)

- [x] 1.1 In `__tests__/flow-persist-sessionmanager.test.ts`, add a failing test: with a real `SessionManager`, append a user message + an assistant `tool_use` (unresolved), then call `emitStartMarker`; assert NO assistant marker message was appended (session has a user message).
- [x] 1.2 Add a failing test: fresh session with NO user message, call `emitStartMarker` then `emitCompletionMarker`; assert BOTH markers are appended and the `hasAssistant` gate opens (buffered `flow-event` entries flush to disk).
- [x] 1.3 Add a failing regression test reproducing the corruption: seed `user` → assistant `tool_use(id)` → (flow start, no result yet) → later `toolResult(id)`; build the message sequence via `buildSessionContext` and assert every assistant `tool_use` is immediately followed by its matching `toolResult` (no marker interleaved).
- [x] 1.4 In `extensions/flow-engine/flow-persist.ts` `FlowEventPersister.appendMarker`, add a guard: read the active `SessionManager` (`getSessionManager()`), and return early (skip append) when `getEntries()`/`getBranch()` contains any `type === "message"` entry with `message.role === "user"`. Keep the non-empty text block and zero-`usage` shape unchanged.
- [x] 1.5 Run the tests from 1.1–1.3; confirm they pass. Confirm existing `flow-persist.test.ts` / `flow-persist-sessionmanager.test.ts` still pass.

## 2. Verify against real corrupted logs

- [x] 2.1 Re-run the parent-chain detector over the 5 known-corrupted sessions and confirm the fix would prevent new corruption (markers skipped when a user message exists). Detector: walk `parentId` leaf→root, drop `custom`, assert no assistant `[flow] …` marker sits between an assistant `tool_use` and its `tool_result`. Verified: all 5 sessions had a user message present at the marker → guard skips → corruption prevented.
- [x] 2.2 Confirm headless flow-only sessions (no user message) still receive both markers and still resume (spot-check one `flow-test` session shape in a test). Verified: 9/9 headless `flow-test` sessions have no user message and retain their `[flow]` markers; covered by the headless test in 1.2.

## 3. Wrap up

- [x] 3.1 Update `flow-session-persistence` spec on archive (delta already authored under this change).
- [x] 3.2 Note the out-of-scope user-interrupt race (`user` message mid-tool-call) as a follow-up issue. Recorded in proposal Non-goals + design Non-Goals (session `019f2881-7ef5`: a `user` message spliced between a `tool_use` and its `tool_result`; distinct mechanism, needs its own change).
