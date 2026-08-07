# Flow Session Persistence

## Purpose

pi-flows durably records the flow-run lifecycle event stream into the active pi session via `pi.appendEntry`, opening pi's `hasAssistant` flush gate with a non-empty assistant marker at flow start so the session JSONL exists for the whole run. This lets flow runs survive reload/resume and replay on the dashboard, while persistence remains additive to the existing live event-forwarding path.
## Requirements
### Requirement: Flow lifecycle events are durably recorded in the pi session

pi-flows SHALL persist every emitted flow-run lifecycle event — the events raised by the `EventEmitObserver` (`flow:flow-started`, `flow:agent-started`, `flow:agent-complete`, `flow:assistant-text`, `flow:thinking-text`, `flow:subagent-tool-call`, `flow:subagent-tool-result`, `flow:auto-decision`, `flow:loop-iteration`, `flow:agent-error`, `flow:complete`) — into the active pi session by calling `pi.appendEntry` with a stable `customType` of `flow-event`. Persistence SHALL be additive: it MUST NOT replace, delay, or alter the existing live `pi.events.emit` forwarding path. The recorded entry SHALL be derived from the same payload object used for the live emission so the persisted and forwarded data cannot diverge.

Architect lifecycle events (`flow:architect-*`) are a separate lifecycle (no `flowRunId`, emitted from scattered `flow-workspace` sites) and are OUT OF SCOPE for this capability; the persistence helper SHALL be reusable so architect-event persistence can be added by a follow-up change.

The persisted entry's `data` SHALL be a `custom` entry (not in LLM context, not displayed in the transcript).

#### Scenario: Each emitted flow event is persisted

- **WHEN** the `EventEmitObserver` emits a flow-run lifecycle event during a flow run
- **THEN** pi-flows SHALL also call `pi.appendEntry("flow-event", <record>)` for that event
- **AND** the live `pi.events.emit` of the same event SHALL still occur unchanged

#### Scenario: Persistence does not enter LLM context or transcript

- **WHEN** a `flow-event` entry is appended
- **THEN** the entry SHALL be a `type: "custom"` session entry (via `pi.appendEntry`)
- **AND** it SHALL NOT be emitted as a displayed `custom_message` and SHALL NOT participate in the model's context window

### Requirement: Persisted flow event record carries the cross-repo contract fields

The `data` recorded with each `flow-event` entry SHALL contain:
- `seq`: a monotonically increasing integer assigned at emit time, used to reproduce live ordering on replay;
- `eventType`: the **dashboard protocol event name** (the mapped name such as `flow_tool_call`, `flow_assistant_text`, `flow_agent_started`), NOT the raw `flow:*` channel name;
- `data`: the exact payload the bridge would have forwarded for that event;
- `flowRunId`: an identifier for the originating flow run.

The `flowRunId` SHALL be minted **once per run by the engine** (`FlowManager.start`) and supplied to the persister; the persister SHALL record the **supplied** id and SHALL NOT self-mint a run id on the `flow:flow-started` channel. This guarantees the `flowRunId` on every persisted record for a run equals the run id carried on that run's live `flow:*` payloads (a single identity across the live and persisted planes). The orphan/reconciliation terminal-record path SHALL continue to inject an **explicit** `flowRunId` (the orphaned run's id, read from disk) independently of any live run id.

Recording the already-mapped `eventType` SHALL allow a consumer to re-forward `{ eventType, data }` verbatim without a second name-mapping table.

#### Scenario: Record uses the mapped protocol event name

- **WHEN** pi-flows persists the event raised as `flow:subagent-tool-call`
- **THEN** the recorded `eventType` SHALL be `flow_tool_call` (the dashboard protocol name)
- **AND** the recorded `data` SHALL equal the payload forwarded on the live path

#### Scenario: Sequence numbers reproduce live ordering

- **WHEN** multiple agents emit events concurrently during a parallel flow
- **THEN** each persisted record SHALL carry a `seq` that strictly increases in emit order
- **AND** a consumer ordering records by `seq` SHALL reproduce the order the live reducer observed

#### Scenario: Persisted id equals the live run id

- **WHEN** a run emits lifecycle events and pi-flows persists them
- **THEN** the `flowRunId` on every persisted record for that run SHALL equal the engine-minted run id carried on the same run's live `flow:*` payloads

#### Scenario: Persister does not self-mint

- **WHEN** the `flow:flow-started` channel is persisted
- **THEN** the persister SHALL record the run id supplied by the engine
- **AND** the persister SHALL NOT generate a new run id of its own

### Requirement: Full per-agent timeline fidelity is preserved by persistence

Persistence SHALL cover every timeline-bearing event kind, not only tool calls. Specifically, the recorded stream SHALL include assistant text (`flow_assistant_text`), reasoning/thinking (`flow_thinking_text`), tool calls (`flow_tool_call`), tool results (`flow_tool_result`), and agent errors (`flow_agent_error`), such that replaying the persisted records reconstructs the identical ordered per-agent `detailHistory` the live reducer produced.

#### Scenario: Reasoning and assistant text survive

- **WHEN** an agent emits assistant text and thinking text before a tool call
- **THEN** the persisted stream SHALL contain the `flow_assistant_text` and `flow_thinking_text` records in their emit order relative to the `flow_tool_call` record

#### Scenario: Replaying records rebuilds the same timeline

- **WHEN** the persisted `flow-event` records for a completed run are re-forwarded in `seq` order to the dashboard's `reduceFlowEvent`
- **THEN** the resulting per-agent `detailHistory` SHALL be equal to the timeline produced from the live event stream

### Requirement: Persistence cadence is per-event

pi-flows SHALL persist exactly one `flow-event` entry per emitted flow-run event (per-event cadence). It SHALL NOT batch, throttle, or add any timed/periodic flush.

#### Scenario: One entry per event

- **WHEN** a flow run emits N flow-run lifecycle events
- **THEN** pi-flows SHALL append exactly N `flow-event` entries (plus at most one gate-open marker, see below)

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

### Requirement: Persist into the session JSONL, never a side channel

pi-flows SHALL persist flow events into the active pi session (the session JSONL) via `appendEntry`, and SHALL NOT use a separate file or side channel as the durable store. Rationale (verified): the dashboard's multi-client streaming, browser-reload, server-restart, and `/resume` reconstruction are fed ONLY by (a) live bridge `event_forward` and (b) session-JSONL replay (`getBranch` / `loadEntriesFromFile` → server `EventStore` → subscribers). A side file rides neither path, so it would require a new bridge, a new server store, and a new replay path in `pi-agent-dashboard`, duplicating — worse — what the session JSONL provides for free.

#### Scenario: Side-file persistence is rejected

- **WHEN** choosing where to persist flow events
- **THEN** pi-flows SHALL write into the session JSONL (rides the existing dashboard replay/streaming for all clients and all reload/restart paths)
- **AND** pi-flows SHALL NOT introduce a side file that would require new dashboard bridge/store/replay code

### Requirement: Reconstruction ownership boundary

pi-flows SHALL NOT itself rebuild dashboard or TUI flow UI state from persisted entries. Reconstruction on reload SHALL be performed by the consumer (the dashboard's replay path re-forwarding the persisted records into its existing reducer). pi-flows' responsibility ends at durable, ordered, contract-shaped recording.

#### Scenario: Engine records but does not reconstruct

- **WHEN** a session is resumed after a flow run completed
- **THEN** pi-flows SHALL make the `flow-event` records available via `ctx.sessionManager.getEntries()`
- **AND** pi-flows SHALL NOT be required to re-render the flow card itself; the consumer reconstructs from the records

#### Scenario: Persistence is inert without a consumer

- **WHEN** no dashboard replay branch consumes `flow-event` entries
- **THEN** the persisted entries SHALL have no user-visible effect (they are ignored by the current replay) and SHALL NOT break session resume

### Requirement: Flush-gate markers carry a resume-safe zero usage

The assistant flush-gate markers appended via `sessionManager.appendMessage` (flow start, flow finished, and any other marker routed through `appendMarker`) SHALL carry a complete, well-formed zero `usage` object matching pi-ai's `Usage` type — `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`, all `0`. The markers SHALL remain non-empty text blocks (the existing gate-open requirement is unchanged).

Rationale (code-grounded, triple-confirmed): on resume, pi's `_findLastAssistantMessage()` returns the marker (it matches `role === "assistant"` and does not check for `usage`). The next user send runs `_checkCompaction` → `calculateContextTokens(assistantMessage.usage)` (`agent-session.js:1441`), whose body is `usage.totalTokens || usage.input + …` (`compaction.js:79`). A `usage`-less marker makes this read `undefined.totalTokens` and throw. The throw rejects `sendUserMessage` and is swallowed by pi's `emitError({ event: "send_user_message" })` — the user's message is dropped with no turn and no visible error. A complete zero `Usage` makes `calculateContextTokens` return `0` (so `shouldCompact(0, …)` is false — no spurious compaction) AND keeps the unconditional `usage.cost.total` read in `getSessionStats` (`agent-session.js:2355`) safe.

#### Scenario: Marker usage makes the next user send safe after resume

- **WHEN** a flow marker is the last assistant message and the user sends a new message on resume
- **THEN** `calculateContextTokens(marker.usage)` SHALL return `0` without throwing
- **AND** the user message SHALL be delivered (not swallowed by `emitError`)

#### Scenario: Marker usage is a complete zero Usage

- **WHEN** pi-flows appends any flush-gate marker
- **THEN** the appended message SHALL include `usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` all `0`
- **AND** `usage.cost` SHALL be present with `input`, `output`, `cacheRead`, `cacheWrite`, `total` all `0`
- **AND** the marker content SHALL remain a non-empty text block

### Requirement: Persisted records carry nodeKind so replay reconstructs card type

The `flow-event` records persisted for `flow_agent_started` / `flow_agent_complete` SHALL carry `nodeKind` inside their `data` payload (it rides along because `data` is the exact emitted payload; no `FlowEventRecord` interface change is required). Re-forwarding the persisted records SHALL reconstruct each card's TYPE — not only its timeline — so a replayed run renders the same code / agent / decision cards the live run did. Code-node program logs SHALL replay as logs under a code card, because the card's `nodeKind` is reconstructed from the started record.

#### Scenario: Replay rebuilds card type

- **WHEN** the persisted `flow-event` records for a completed run that included a `code` node are re-forwarded in `seq` order to the dashboard's `reduceFlowEvent`
- **THEN** the rebuilt card for that node SHALL have `nodeKind: "code"`, identical to the live run

#### Scenario: Code logs replay as logs, not LLM output

- **WHEN** a replayed `code` node's `flow_assistant_text` records are re-forwarded after its `flow_agent_started` record carrying `nodeKind: "code"`
- **THEN** those text entries SHALL render as program logs under the reconstructed code card, distinguishable from an agent's assistant text

