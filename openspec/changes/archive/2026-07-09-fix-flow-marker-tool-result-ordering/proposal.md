## Why

When a flow is launched from inside a tool call, pi-flows appends its non-empty assistant "flow start" marker (`[flow] <name> started`) while the launching tool's `tool_use` is still unresolved (the tool is awaiting the flow). The marker splices between the assistant `tool_use` and its `tool_result` in the session parent chain. On the next model call the reconstructed history sends a `tool_result` whose preceding message is the marker (not the `tool_use`), and the Anthropic Messages API rejects it with `400 unexpected tool_use_id ... must have a corresponding tool_use block in the previous message` — breaking the session.

A scan of 1021 local sessions reproduced this in 5 independent sessions (20 corrupted tool_use/tool_result pairs), always the START marker, never the FINISHED marker. Sessions where flows launched outside a tool boundary showed zero corruption.

## What Changes

- pi-flows SHALL append the flow lifecycle markers (start and completion) only when the active session contains **no user message**. When a user message already exists, the session is interactive/managed: a real assistant turn already opened the flush gate, so the marker is redundant and skipping it prevents the tool_use/tool_result corruption.
- Headless flow-only sessions (no user message) are unchanged: both markers still fire, opening the gate at start and reporting status at completion.
- Add a regression test: launch a flow from inside a tool call and assert the reconstructed message sequence keeps each assistant `tool_use` immediately followed by its `tool_result` (no marker interleaved).

Non-goals: the separate user-interrupt race (a user prompt arriving mid-tool-call, observed once as a `user` message between `tool_use` and `tool_result`) is out of scope.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `flow-session-persistence`: the "assistant marker opens the flush gate" requirement gains an ordering guard — markers are appended only when the session has no user message, so the marker can never splice between a `tool_use` and its `tool_result`.

## Impact

- `extensions/flow-engine/flow-persist.ts` — `FlowEventPersister.appendMarker` (and/or `emitStartMarker` / `emitCompletionMarker`): add a "no user message in session" guard before `appendMessage`.
- Reads the active `SessionManager` (already captured via `getSessionManager`) to inspect entries.
- No change to the `flow-event` `appendEntry` persistence path, event cadence, or the dashboard protocol.
- Existing already-corrupted session logs are not repaired by this change (source-side prevention only); reader-side repair in pi core is a possible follow-up.
