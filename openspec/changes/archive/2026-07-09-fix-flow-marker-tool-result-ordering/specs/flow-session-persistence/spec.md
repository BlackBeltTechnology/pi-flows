## MODIFIED Requirements

### Requirement: A NON-EMPTY assistant marker opens the flush gate at flow START (and reports status at completion)

pi-flows SHALL append a **non-empty** assistant marker via `ctx.sessionManager.appendMessage` at **flow start** (e.g. content text `"[flow] <name> started"`) to open pi's persistence gate. (Gate mechanism: pi's `SessionManager` buffers entries in memory and only writes to disk once the session contains a `type:"message", role:"assistant"` entry — the `hasAssistant` gate; once open it is sticky and every subsequent `appendEntry` writes immediately. `custom`/`custom_message` entries do NOT open it — verified.) Opening the gate at start — not only at completion — means the session JSONL exists for the **whole run**, so every subsequent `flow-event` `appendEntry` is written to disk in real time. This is required for two behaviors: (a) a **mid-run** stop + `/resume` reattaches under the **same session id** (preventing a duplicate session), and (b) a mid-run reload survives. pi-flows SHALL also append a non-empty completion marker (e.g. `"[flow] <name> finished"`) on `flow:complete` to report status.

Both markers double as accurate flow-status context for the parent model managing the flow.

The marker content MUST use a **non-empty text block**. pi-flows SHALL NOT append an assistant message whose content is an empty text block (`[{ type: "text", text: "" }]`): the Anthropic Messages API rejects that exact shape with `400 "messages: text content blocks must be non-empty"` on the next request / session resume (anthropics/claude-code#62396), making the session **unresumable**.

**Ordering guard (tool_use/tool_result adjacency).** pi-flows SHALL append a lifecycle marker (start or completion) ONLY when the active session contains **no message with role `user`**. When the session already contains a user message, pi-flows SHALL NOT append the marker.

Rationale: a session with a user message is interactive/managed — a real assistant turn already exists, so the `hasAssistant` gate is already open and the marker is redundant. Critically, when a flow is launched from inside a tool call, the launching tool's assistant `tool_use` is still unresolved (its `tool_result` is not yet appended) at flow-start. Appending an assistant marker at that moment splices it between the `tool_use` and its `tool_result` in the parent chain. Because the marker is a real assistant message that participates in LLM context (unlike the excluded `flow-event` customs), the reconstructed history then presents a `tool_result` whose preceding message is the marker, not the `tool_use` — which the Anthropic Messages API rejects with `400 unexpected tool_use_id ... must have a corresponding tool_use block in the previous message`, breaking the session on the next model call.

The "no user message" predicate is the correct partition: a headless flow-only session (automation launch, no user prompt) has no user message and no assistant message, so the marker is both needed (to open the gate) and safe (appended at the session root, never mid-tool-call); the START marker creates an assistant message but NOT a user message, so the completion marker still fires in a headless run. An empirical scan of 1021 local sessions found zero cases of a marker required to open the gate while a user message was already present, so the guard has no regression set. The earlier "unguarded" allowance was verified only against marker-before-user-turn and leading/consecutive markers; it did not cover the `tool_use`→`tool_result` interleave, which this guard fixes.

This guard SUPERSEDES the prior "No first-message-role guard and no alternation guard are required" allowance and the instruction to "NOT rely on ... the absence of a preceding user message." The non-empty text block remains the universally safe marker shape; the presence of a user message now gates whether the marker is appended at all.

#### Scenario: Non-empty marker opens the gate and flushes to disk (headless flow)

- **WHEN** a headless flow (no user message in the session) runs and pi-flows appends a non-empty assistant marker via `sessionManager.appendMessage`
- **THEN** the `hasAssistant` gate SHALL open and the entire buffered `flow-event` stream SHALL be flushed to the session JSONL
- **AND** a cold `/resume` SHALL recover every flushed `flow-event` entry

#### Scenario: Empty text block is forbidden

- **WHEN** choosing the marker content
- **THEN** pi-flows SHALL use a non-empty text block (e.g. `[{ type: "text", text: "[flow] <name> finished" }]`)
- **AND** pi-flows SHALL NOT emit an empty text block `[{ type: "text", text: "" }]`, because the Anthropic API rejects it on the next request / resume (`400 messages: text content blocks must be non-empty`, verified against claude-haiku-4-5)

#### Scenario: Marker skipped when the session has a user message

- **WHEN** a flow starts or completes and the active session already contains a message with role `user`
- **THEN** pi-flows SHALL NOT append the lifecycle marker
- **AND** persistence SHALL still function because an assistant turn already opened the `hasAssistant` gate

#### Scenario: Flow launched from inside a tool call keeps tool_use/tool_result adjacent

- **WHEN** a tool call launches a flow and the flow's start marker would otherwise be appended while the launching assistant `tool_use` is unresolved
- **THEN** pi-flows SHALL NOT append the marker (the session has a user message)
- **AND** the reconstructed message sequence SHALL keep each assistant `tool_use` immediately followed by its matching `tool_result`, so the Anthropic API does not reject the next request with `unexpected tool_use_id`

#### Scenario: Headless completion marker still fires

- **WHEN** a headless flow (no user message) reaches `flow:complete`
- **THEN** pi-flows SHALL append the non-empty completion marker, because the start marker created an assistant message but no user message and the "no user message" guard is still satisfied

#### Scenario: In-memory reload is gate-independent

- **WHEN** flow events are emitted and the dashboard reconnects while pi is alive (reads `getBranch()`/`getEntries()`)
- **THEN** all `flow-event` entries SHALL be visible regardless of disk-flush state, because entries are held in memory before the gate
