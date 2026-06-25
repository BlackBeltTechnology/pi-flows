## 1. NodeKind type

- [x] 1.1 Add a `NodeKind` union (`agent | fork | agent-decision | code | code-decision | flow-ref`) to `extensions/flow-engine/types.ts`
- [x] 1.2 Widen the `onAgentStarted` / `onAgentComplete` option signatures in `flow-execution.ts` and `execute-code-step.ts` to `extra?: { nodeKind?: NodeKind; target?: string; ... }` (rename the existing `kind` → `nodeKind`)

## 2. Emit nodeKind from every executor (TDD)

- [x] 2.1 Write failing tests asserting each executor passes its `nodeKind` to `onAgentStarted` / `onAgentComplete` (agent, fork, agent-decision, code, code-decision, flow-ref)
- [x] 2.2 Emit `nodeKind: "agent"` from the agent step path in `flow-execution.ts`
- [x] 2.3 Emit `nodeKind` for `fork` and `agent-decision` paths in `flow-execution.ts`
- [x] 2.4 Emit `nodeKind` for `flow-ref` (N/A — flow-ref recurses into the sub-flow via `executeFlowRefStep` and emits no own agent lifecycle; the sub-flow's nodes emit their own kinds)
- [x] 2.5 Rename `kind` → `nodeKind` in `execute-code-step.ts` and add the resolved handler `target` to the started payload
- [x] 2.6 Confirm tests from 2.1 pass

## 3. Forward nodeKind through the FlowManager seam (TDD)

- [x] 3.1 Write a failing test asserting a registered observer's `onAgentStarted` receives `nodeKind` for an `agent` node (covers the historic drop)
- [x] 3.2 Add the 4th `extra` param to the `FlowManager` `onAgentStarted` / `onAgentComplete` callbacks (`flow-manager.ts:121-135`) and forward it to every observer
- [x] 3.3 Add `extra?: { nodeKind?: NodeKind; target?: string }` to the `FlowObserver` `onAgentStarted` / `onAgentComplete` signatures
- [x] 3.4 Confirm the test from 3.1 passes

## 4. Carry nodeKind on flow:* payloads and persistence (TDD)

- [x] 4.1 Write a failing test asserting `EventEmitObserver` includes `nodeKind` on `flow:agent-started` / `flow:agent-complete` payloads for all node types
- [x] 4.2 Add `nodeKind` (and code `target`) to the `flow:agent-started` / `flow:agent-complete` payloads in `flow-tui.ts` `EventEmitObserver`
- [x] 4.3 Write a test that `nodeKind` + `target` land in the persisted `flow_agent_started` `FlowEventRecord.data` (the dashboard `reduceFlowEvent` that rebuilds the card from it is cross-repo)
- [x] 4.4 Verify `nodeKind` lands in `FlowEventRecord.data` automatically (no record-schema change); confirm tests pass

## 5. Verification & docs

- [x] 5.1 Run the gate: `npm run typecheck`, `npm run lint`, `npx vitest run --exclude '**/.worktrees/**' --exclude '**/node_modules/**'`
- [x] 5.2 Update `docs/dashboard-integration.md` + `agent-docs/dashboard-integration.md` (delegate to subagent): note `nodeKind` on `flow_agent_started`/`flow_agent_complete`, dashboard selects card renderer by it (no `FLOW_EVENT_MAP` change), code logs are logs by card kind
- [x] 5.3 Update `docs/events-api.md` + `agent-docs/events-api.md` (delegate to subagent): document the `NodeKind` taxonomy and the `FlowObserver` signature change
- [x] 5.4 Add a CHANGELOG entry
- [x] 5.5 Note the cross-repo follow-up: pi-agent-dashboard reducer reads `nodeKind` off `flow_agent_started` to pick the card renderer
