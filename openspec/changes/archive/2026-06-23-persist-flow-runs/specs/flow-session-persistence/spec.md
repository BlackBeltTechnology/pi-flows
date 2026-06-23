## ADDED Requirements

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

Recording the already-mapped `eventType` SHALL allow a consumer to re-forward `{ eventType, data }` verbatim without a second name-mapping table.

#### Scenario: Record uses the mapped protocol event name

- **WHEN** pi-flows persists the event raised as `flow:subagent-tool-call`
- **THEN** the recorded `eventType` SHALL be `flow_tool_call` (the dashboard protocol name)
- **AND** the recorded `data` SHALL equal the payload forwarded on the live path

#### Scenario: Sequence numbers reproduce live ordering

- **WHEN** multiple agents emit events concurrently during a parallel flow
- **THEN** each persisted record SHALL carry a `seq` that strictly increases in emit order
- **AND** a consumer ordering records by `seq` SHALL reproduce the order the live reducer observed

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

pi-flows SHALL append a **non-empty** assistant marker via `ctx.sessionManager.appendMessage` at **flow start** (e.g. content text `"[flow] <name> started"`) to open pi's persistence gate. (Gate mechanism: pi's `SessionManager` buffers entries in memory and only writes to disk once the session contains a `type:"message", role:"assistant"` entry — the `hasAssistant` gate; once open it is sticky and every subsequent `appendEntry` writes immediately. `custom`/`custom_message` entries do NOT open it — verified.) Opening the gate at start — not only at completion — means the session JSONL exists for the **whole run**, so every subsequent `flow-event` `appendEntry` is written to disk in real time. This is required for two behaviors: (a) a **mid-run** stop + `/resume` reattaches under the **same session id** (preventing a duplicate session), and (b) a mid-run reload survives. pi-flows SHALL also append a non-empty completion marker (e.g. `"[flow] <name> finished"`) on `flow:complete` to report status; this is gate-redundant once the start marker fired but is useful flow-status context.

Both markers double as accurate flow-status context for the parent model managing the flow.

The marker content MUST use a **non-empty text block**. pi-flows SHALL NOT append an assistant message whose content is an empty text block (`[{ type: "text", text: "" }]`): the Anthropic Messages API rejects that exact shape with `400 "messages: text content blocks must be non-empty"` on the next request / session resume (anthropics/claude-code#62396), making the session **unresumable**.

Empirically verified against `claude-haiku-4-5` (live API):
- non-empty marker `"[flow] <name> finished"` followed by a user turn → **accepted**;
- empty text block `[{type:"text",text:""}]` → **400 rejected**;
- empty content array `content:[]` → accepted; and a leading assistant message with no prior user turn → accepted.
  Because `content:[]` and leading-assistant are provider-specific tolerances (verified on haiku, not guaranteed elsewhere), pi-flows SHALL use the **non-empty text marker** as the universally safe form and SHALL NOT rely on `content:[]` or on the absence of a preceding user message.

The marker is intentionally visible in the transcript and IS part of the LLM context. This is acceptable and desirable: it is accurate, useful context for the parent model that is managing the flow ("one stone, two birds").

pi-flows SHALL append a marker at **flow start** (the gate-opener) and at **flow completion** (status), unguarded. No first-message-role guard and no alternation guard are required: a leading assistant marker (flow-first session) and consecutive assistant markers (back-to-back flows, or a single flow's start+finished pair, since the intervening `flow-event` customs are excluded from LLM context) are all accepted by the provider (verified against `claude-haiku-4-5`: leading, two-consecutive, and three-consecutive all succeed). Only the empty-text-block shape is forbidden. The start marker opens the sticky gate (the rest is free); every marker is also useful flow-status context.

#### Scenario: Non-empty marker opens the gate and flushes to disk

- **WHEN** a flow runs and pi-flows appends a non-empty assistant marker via `sessionManager.appendMessage`
- **THEN** the `hasAssistant` gate SHALL open and the entire buffered `flow-event` stream SHALL be flushed to the session JSONL
- **AND** a cold `/resume` SHALL recover every flushed `flow-event` entry

#### Scenario: Empty text block is forbidden

- **WHEN** choosing the marker content
- **THEN** pi-flows SHALL use a non-empty text block (e.g. `[{ type: "text", text: "[flow] <name> finished" }]`)
- **AND** pi-flows SHALL NOT emit an empty text block `[{ type: "text", text: "" }]`, because the Anthropic API rejects it on the next request / resume (`400 messages: text content blocks must be non-empty`, verified against claude-haiku-4-5)

#### Scenario: Marker emitted at flow start (gate-opener) and completion, unguarded

- **WHEN** a flow starts (whether or not the session already has an assistant message)
- **THEN** pi-flows SHALL append one non-empty assistant marker (`[flow] <name> started`), opening the gate so the session file exists for the whole run
- **AND** on `flow:complete` pi-flows SHALL append a non-empty completion marker (`[flow] <name> finished`)
- **AND** both SHALL be safe regardless of position — leading and consecutive assistant markers are accepted by the provider (verified, `claude-haiku-4-5`)
- **AND** once the start marker opens the gate, every subsequent `flow-event` `appendEntry` SHALL be written to disk immediately (sticky gate), so a mid-run stop+`/resume` reattaches under the same session id

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
