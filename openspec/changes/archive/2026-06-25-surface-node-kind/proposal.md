## Why

Flow steps have no first-class "node kind". Today only `code` / `code-decision` nodes carry a `kind` tag — and only because they impersonate the agent lifecycle channel — while agent / fork / agent-decision / flow-ref carry none. Even that tag is silently dropped at the `FlowManager` fan-out (a 3-arg handler assigned to a 4-arg callback type), so it never reaches observers, the `flow:*` payloads, the persisted records, or the dashboard. As a result the dashboard cannot pick a card renderer by node type for live OR replayed runs, and a code node's program logs are indistinguishable from an agent's LLM output.

## What Changes

- Introduce a single first-class `NodeKind` discriminator — `agent | fork | agent-decision | code | code-decision | flow-ref` — emitted by **every** node executor, not just code.
- Thread `nodeKind` through the `FlowManager` callback fan-out (the dropped 4th `extra` arg) and add it to the `FlowObserver` `onAgentStarted` / `onAgentComplete` signatures.
- Carry `nodeKind` on the `flow:agent-started` / `flow:agent-complete` event payloads so it lands in the persisted `FlowEventRecord.data` automatically (no record-schema change — `data` is opaque) and survives replay.
- Code-node `logger()` output stays on `flow:assistant-text`; it is identified as a *program log* by the **card's** `nodeKind` (decided once at `agent-started`), so no new event type and no per-line marker are needed.
- Include the resolved code-handler `target` path on the `flow:agent-started` payload for `code` / `code-decision` nodes, so a replayed code card can show *what ran*, not only what it printed. (Full source-body capture is explicitly out of scope.)
- Disambiguate naming: `nodeKind` on the node vs the existing timeline-entry `kind` (`text | thinking | tool | error`) in the dashboard, so the two stop colliding.
- Cross-repo: no new `FLOW_EVENT_MAP` entry. The pi-agent-dashboard change is reducer-side only — read `nodeKind` off `flow_agent_started` to choose the card renderer. The two repos land independently.

## Capabilities

### New Capabilities
- `node-kind`: defines the `NodeKind` taxonomy and the end-to-end contract that every node executor emits its kind, `FlowManager` forwards it to observers, and the kind determines card rendering (live and replay). Owns the rule that a code/code-decision card's `assistant-text` entries are program logs by virtue of the card's kind, and that code nodes additionally surface their resolved handler `target`.

### Modified Capabilities
- `dashboard-event-emission`: `flow:agent-started` and `flow:agent-complete` payloads SHALL carry `nodeKind` for all node types; the `FlowManager` callback fan-out SHALL forward the lifecycle `extra` argument rather than dropping it.
- `flow-session-persistence`: persisted `flow-event` records SHALL carry `nodeKind` in `data` so replay reconstructs each card's TYPE (not just its timeline), and code-node log lines replay as logs under a code card.

## Impact

- **pi-flows code**: `types.ts` (`NodeKind`, executor option signatures), `execute-code-step.ts` (already emits; widen for `target`), `flow-execution.ts` (emit `nodeKind` for agent/fork/agent-decision), `flow-manager.ts:121-135` (forward `extra`), `flow-tui.ts` `EventEmitObserver` (payload fields + `FlowObserver` signatures), `flow-dashboard/*` (pick renderer by `nodeKind`; rename collision).
- **Persistence/replay**: `FlowEventRecord.data` gains `nodeKind` (no interface change); replay path unchanged (idempotent re-forward).
- **Cross-repo (pi-agent-dashboard)**: reducer reads `nodeKind` from `flow_agent_started` to select card renderer; no `FLOW_EVENT_MAP` addition. Lands independently.
- **No change** to the marker flush-gate workaround, the `seq` ordering, or the live `pi.events.emit` path.
