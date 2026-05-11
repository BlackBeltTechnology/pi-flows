# Dashboard Event Emission

## Purpose

Defines the contract by which `pi-flows` emits `flow:*` lifecycle events that are observable by `pi-agent-dashboard` (and any other dashboard observer). The capability covers which lifecycle phases MUST emit an event whose name is wired through the dashboard's `FLOW_EVENT_MAP`, what payloads those events carry, how `pi-flows` declares its peer dependencies for the dashboard integration, and where contributors find the architectural rationale for the split between this engine repo and the dashboard's React reaction code.

In short: any architect or summary lifecycle state that a dashboard user is expected to see SHALL be reachable via a mapped event, and the integration surface SHALL be documented and pinned.

## Requirements

### Requirement: Architect init-error event is observable by dashboard observers

When the architect entry path (`flow:architect-started` followed by initial-context generation) fails before any `flow:architect-text` or `flow:architect-preview` is produced, pi-flows SHALL emit an event whose name is present in pi-agent-dashboard's `FLOW_EVENT_MAP` table. The event SHALL include at minimum: `{ flowName, error }` where `error` is a human-readable message and an optional `stack` field for debugging.

Two acceptable implementations satisfy this requirement:

- **Option A (pi-flows-side fix):** rename the emission from `flow:architect-init-error` to one of the names already mapped (e.g., `flow:architect-error` which the dashboard wires to `architect_error`). The init failure is reported as a regular architect error with a distinguishing field such as `phase: "init"`.
- **Option B (cross-repo fix):** keep the `flow:architect-init-error` name and document a one-line addition to `pi-agent-dashboard/packages/extension/src/flow-event-wiring.ts#FLOW_EVENT_MAP` as a delegated change.

This change SHALL pick exactly one option and document the choice in `design.md`.

#### Scenario: Init-error surfaces in the dashboard

- **WHEN** the architect path fails during initial-context generation (e.g., model rejects the system prompt, file scan errors out, prompt template is malformed)
- **THEN** pi-flows SHALL emit an event whose name is in `FLOW_EVENT_MAP`
- **AND** the dashboard SHALL receive a protocol event with `eventType` matching the map entry
- **AND** the protocol event's payload SHALL contain the error message

#### Scenario: Init-error does not silently swallow

- **WHEN** the architect init phase fails and pi-flows does NOT emit a mapped event
- **THEN** this is a regression of this requirement and SHALL fail the integration test in `verification`

### Requirement: Architect abort event is observable by dashboard observers

When the user aborts an architect session via the TUI's abort affordance OR the dashboard's external abort path, pi-flows SHALL emit an event whose name is present in `FLOW_EVENT_MAP`. The event SHALL include at minimum `{ flowName }` and optionally `{ reason: "user-abort" | "external-abort" | "timeout" }`.

The same two-option disposition (rename vs cross-repo wire) applies as for init-error. `design.md` SHALL state the chosen option for both events together.

#### Scenario: Abort surfaces in the dashboard

- **WHEN** the architect is mid-flight and the user invokes abort
- **THEN** pi-flows SHALL emit a mapped abort event
- **AND** the dashboard SHALL receive a protocol event corresponding to it
- **AND** the resulting `architectState.status` on the dashboard side SHALL transition to `"cancelled"` or equivalent terminal state

#### Scenario: Abort is symmetric with cancellation

- **WHEN** an abort event reaches the dashboard
- **THEN** the dashboard's reducer SHALL handle it the same way it handles `flow:architect-cancelled` (already mapped to `architect_cancelled`)
- **AND** no Flow* UI state SHALL remain in an indeterminate "running but no incoming events" state

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

- **WHEN** the pin is read for `@mariozechner/pi-coding-agent`
- **THEN** the range SHALL include the version currently in `pi-flows/node_modules/@mariozechner/pi-coding-agent/package.json`
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
