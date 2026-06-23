## ADDED Requirements

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
