## REMOVED Requirements

### Requirement: Architect init-error event is emitted via `flow:architect-init-error`

**Reason**: The flow-architect agent and its entire event lifecycle are deleted. Authoring moves to the main session via the `flow-authoring` skill and gated `flow_agents` / `flow_write` tools, which surface errors as ordinary tool diagnostics. There is no longer an architect init phase to fail.

**Migration**: Dashboard observers SHALL drop `flow:architect-init-error` from `FLOW_EVENT_MAP`. Authoring failures now appear as normal main-session tool-result diagnostics; no dashboard event replaces this one.

### Requirement: Architect abort event is observable by dashboard observers

**Reason**: The flow-architect agent is deleted; there is no long-running architect session to abort. Main-session authoring is governed by the user's own turn, not a spawned agent lifecycle.

**Migration**: Dashboard observers SHALL drop the architect abort event (and the `flow:architect-cancelled` mapping) from `FLOW_EVENT_MAP`. No replacement event is emitted for main-session authoring.
