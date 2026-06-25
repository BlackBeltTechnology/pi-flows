# Dashboard Event Emission

## Purpose

Defines the contract by which `pi-flows` emits `flow:*` lifecycle events that are observable by `pi-agent-dashboard` (and any other dashboard observer). The capability covers which lifecycle phases MUST emit an event whose name is wired through the dashboard's `FLOW_EVENT_MAP`, what payloads those events carry, how `pi-flows` declares its peer dependencies for the dashboard integration, and where contributors find the architectural rationale for the split between this engine repo and the dashboard's React reaction code.

In short: any architect or summary lifecycle state that a dashboard user is expected to see SHALL be reachable via a mapped event, and the integration surface SHALL be documented and pinned.
## Requirements
### Requirement: Summary lifecycle has matched start-and-ready events

The `pi-flows` summary generation lifecycle SHALL emit a `flow:summary-started` event when generation begins, in addition to the existing `flow:summary-ready` emitted on completion. The dashboard's `FLOW_EVENT_MAP` already wires `flow:summary-started → flow_summary_started`; pi-flows currently never emits it, leaving the dashboard unable to show a "generating summary…" intermediate state.

The started event SHALL include `{ flowName, sessionId }` (or whichever identifying fields are stable at that point in the lifecycle). The ready event SHALL continue to include the computed summary payload as it does today.

#### Scenario: Started precedes ready

- **WHEN** the summary generation begins for a completed flow
- **THEN** pi-flows SHALL emit `flow:summary-started` BEFORE the first model token is requested
- **AND** pi-flows SHALL emit `flow:summary-ready` exactly once after the summary payload is computed

#### Scenario: Started is emitted exactly once per summary cycle

- **WHEN** a single flow completes and triggers a single summary generation
- **THEN** exactly one `flow:summary-started` SHALL be emitted
- **AND** exactly one `flow:summary-ready` SHALL be emitted
- **AND** the dashboard's `flow_summary_started` and `flow_summary_ready` protocol events SHALL appear in the same order

#### Scenario: No regression when summary is dismissed

- **WHEN** the summary is dismissed before being rendered
- **THEN** `flow:summary-dismissed` SHALL still be emitted (existing behavior)
- **AND** the started/ready pair from this cycle SHALL still appear in the observer log

### Requirement: pi-flows package.json declares real peerDependency ranges

The `package.json#peerDependencies` block SHALL NOT use the unconstrained `"*"` specifier for any pi-namespace peer dependency. Each peer SHALL declare a caret range pinned to the lowest version currently known to work (the version present in this repo's `node_modules/` at the time of this change).

The repo SHALL document, in `design.md`, how the pinned lower bound was chosen (i.e., the rule: pick the version from `node_modules/<name>/package.json` and apply a caret).

#### Scenario: peerDependencies do not use "*"

- **WHEN** parsing `pi-flows/package.json`
- **THEN** the `peerDependencies` object SHALL NOT contain any value equal to `"*"`
- **AND** every value SHALL be a parseable semver range with a defined lower bound

#### Scenario: Pin reflects current working version

- **WHEN** the pin is read for `@earendil-works/pi-coding-agent`
- **THEN** the range SHALL include the version currently in `pi-flows/node_modules/@earendil-works/pi-coding-agent/package.json`
- **AND** the range SHALL use the caret form (e.g., `^X.Y.Z`)

### Requirement: Integration architecture is documented

The repo SHALL contain a `docs/dashboard-integration.md` document explaining:

- pi-flows owns the engine and emits `flow:*` events
- pi-agent-dashboard's `packages/flows-plugin/` owns the React reaction code
- The two repos are intentionally separate; the dashboard's primitive registry (`add-plugin-ui-primitive-registry` in dashboard repo) is the architectural direction that supersedes any plan to relocate React source into pi-flows
- Contributors who want to change the dashboard's flow rendering open PRs against pi-agent-dashboard, not pi-flows
- Contributors who want to add new flow events emit them in pi-flows AND coordinate a one-line addition to `FLOW_EVENT_MAP` in the dashboard repo

#### Scenario: docs/dashboard-integration.md exists and explains the split

- **WHEN** reading `docs/dashboard-integration.md`
- **THEN** the file SHALL contain prose that names both repos by URL
- **AND** SHALL name the dashboard's `packages/flows-plugin/` directory as the canonical React reaction location
- **AND** SHALL name `extensions/flow-engine/` as the canonical event emission location in this repo
- **AND** SHALL reference the dashboard's primitive registry as the reason no cross-repo move is planned

#### Scenario: README points contributors at the integration doc

- **WHEN** reading the main `README.md`
- **THEN** there SHALL be a section header that mentions the dashboard integration
- **AND** that section SHALL link to `docs/dashboard-integration.md`

### Requirement: Per-agent error lifecycle event is emitted via `flow:agent-error`

When an agent step fails with a message-level error (as opposed to a tool result with `isError: true`), pi-flows SHALL emit `flow:agent-error` with `{ agentName, stepId, text }`, where `text` is the human-readable error. This gives the dashboard's existing `{ kind: "error" }` timeline entry a producer: today `FlowDetailEntry` defines an error kind but no flow event emits it, so message-level agent errors only flip `flow_agent_complete.status` and never appear as a discrete timeline entry.

The event SHALL be raised through a `FlowObserver` error hook (e.g. `onError`) so that both the live forward and the durable `flow-event` recording (see the `flow-session-persistence` capability) capture it.

#### Scenario: Agent message-level error emits a timeline event

- **WHEN** an agent step fails with a message-level error during a flow run
- **THEN** pi-flows SHALL emit `flow:agent-error` with `{ agentName, stepId, text }`
- **AND** the agent's terminal `flow:agent-complete` SHALL still carry `status: "error"` (the status flip is retained, not replaced)

#### Scenario: Error event is persisted and replayable

- **WHEN** `flow:agent-error` is emitted
- **THEN** it SHALL be recorded as a `flow-event` entry with `eventType: "flow_agent_error"` per the `flow-session-persistence` contract
- **AND** re-forwarding that record SHALL allow a consumer to append a `{ kind: "error", text }` entry to the agent's `detailHistory`

#### Scenario: Tool errors remain distinct from agent errors

- **WHEN** a tool returns a result with `isError: true`
- **THEN** that error SHALL continue to be conveyed via `flow:subagent-tool-result` (patching the paired tool timeline entry's `isError`), NOT via `flow:agent-error`
- **AND** `flow:agent-error` SHALL be reserved for message-level / step-level agent failures

### Requirement: Inbound `flow:set-edit-mode` event
pi-flows SHALL accept an inbound `flow:set-edit-mode` event carrying `{ enabled: boolean }`, emitted by the dashboard, and handle it identically to the `/flows:edit-mode` command (persist `flows.editFlow`, sync the project-local skill visibility, reconcile tools, live-reload).

#### Scenario: Dashboard drives edit-mode
- **WHEN** the dashboard emits `flow:set-edit-mode` with `{ enabled: true }`
- **THEN** pi-flows enables edit-mode (tools active, skill model-visible) for the session

#### Scenario: Payload without enabled is ignored
- **WHEN** a `flow:set-edit-mode` event arrives without a boolean `enabled`
- **THEN** pi-flows makes no change

### Requirement: Code-decision node lifecycle events carry a distinguishing kind

The `pi-flows` engine SHALL emit the same agent/code lifecycle events for `code-decision` steps and SHALL tag them with `kind: "code-decision"` so the dashboard can render a distinct decision card. The chosen branch SHALL be observable from the completion event (e.g. via the step's typed outputs / routing result), enabling the dashboard to display which branch was taken without re-deriving it.

#### Scenario: Started and complete carry kind
- **WHEN** a `code-decision` step begins and finishes
- **THEN** pi-flows SHALL emit its lifecycle started and complete events with `kind: "code-decision"`

#### Scenario: Chosen branch is observable
- **WHEN** a `code-decision` resolves to branch `auto_approve`
- **THEN** the completion event payload SHALL allow the dashboard to determine the taken branch was `auto_approve`

#### Scenario: Dashboard degrades gracefully without a dedicated card
- **WHEN** a dashboard build has no `code-decision` card registered
- **THEN** the events SHALL still be consumable as a generic node card (the `kind` tag is additive, not required for baseline rendering)

### Requirement: Backward-edge decision nodes emit loop-iteration events

When a `code-decision` or `agent-decision` routes along a backward edge (re-enters an ancestor), the engine SHALL emit the existing `flow:loop-iteration` event for that node with `{ stepId, iteration, maxIterations, loopTarget }`, reusing the established loop-counter bookkeeping. Loop status SHALL be conveyed exclusively by this runtime event, NOT inferred from the presence of `max_iterations` (a static capability that does not imply the node looped on a given run).

#### Scenario: Backward edge fires loop-iteration
- **WHEN** a `code-decision` returns a branch whose target is an ancestor step
- **THEN** the engine SHALL emit `flow:loop-iteration` with the node's `stepId`, incremented `iteration`, configured `maxIterations`, and the `loopTarget`

#### Scenario: Existing loop badge lights up
- **WHEN** a backward-edge `code-decision` is on iteration 2 of 3
- **THEN** the running node card SHALL display the existing iteration badge (e.g. ↻ 2/3) driven by the loop-iteration event

#### Scenario: Capable-but-not-looping node shows no loop badge
- **WHEN** a `code-decision` declares `max_iterations` but exits on its first pass without taking a backward edge
- **THEN** no `flow:loop-iteration` event SHALL be emitted and no loop badge SHALL be shown

### Requirement: Static flow preview detects backward edges from branches

The static flow preview (pre-run diagram) SHALL determine loop arrows by detecting backward edges in the `branches:` topology of `*-decision` nodes (a branch target that is an ancestor of the node), annotated with the node's `max_iterations`. It SHALL NOT rely on a dedicated loop step type, since `agent-loop-decision` is removed.

#### Scenario: Backward branch rendered as loop arrow
- **WHEN** a `*-decision` node has a branch whose target is an ancestor
- **THEN** the preview SHALL draw a loop arrow to that target annotated with `(max N iterations)`

#### Scenario: All-forward decision renders no loop arrow
- **WHEN** a `*-decision` node's branch targets are all descendants
- **THEN** the preview SHALL render it as a plain decision with no loop arrow

