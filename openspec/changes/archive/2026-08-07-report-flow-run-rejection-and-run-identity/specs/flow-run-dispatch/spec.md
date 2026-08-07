## ADDED Requirements

### Requirement: `flow:run` is the single programmatic entry point for starting a flow

Every host-driven producer that starts a flow (REST dispatch, domain-package tools, dashboard automations, slash commands) SHALL funnel through the `flow:run` event. The engine SHALL handle `flow:run` through one code path with a single set of pre-start checks. There SHALL NOT be a duplicate guard that short-circuits before the shared pre-start checks.

#### Scenario: All producers share one dispatch path

- **WHEN** any host raises `flow:run` with a flow name
- **THEN** the engine SHALL evaluate the same pre-start checks (flow exists, no run active, gate satisfied) before starting
- **AND** no earlier guard SHALL cause a `flow:run` to return before those checks run

### Requirement: A declined `flow:run` emits a terminal, renderable outcome

When `flow:run` does not start a flow, the engine SHALL emit a **terminal `flow:complete`** event — the same channel a real run finalizes on — so the outcome is observable by a consumer that never saw a `flow_started`, and so a host automation runner that finalizes on the forwarded `flow_complete` finalizes the dispatch in seconds rather than wedging until a stale-run reaper fires.

The emitted payload SHALL carry, at stable top-level paths:
- `status: "rejected"` — a machine-readable outcome distinct from a run `"error"` (a run that started and failed);
- `reason: string` — the human-readable cause, **byte-identical** to the string the slash-command registration path emits via `flow:notify` for the same condition (unknown flow / already-running with the active flow name / the gate message);
- `flowName` — the dispatched name;
- `lastResult.result.summary` — the same `reason` string, so an automation runner's result summariser renders it unchanged.

The payload SHALL omit `results` (so the post-flow summary is not generated for a run that never started) and SHALL carry no run identity (no run existed). The message strings SHALL be produced by a single shared source used by both the command path and the dispatch path, so parity holds by construction.

#### Scenario: Unknown flow name

- **WHEN** `flow:run` names a flow that does not exist
- **THEN** the engine SHALL emit `flow:complete` with `status: "rejected"`, `reason` equal to the command path's "no longer exists" message, and `flowName` set to the dispatched name
- **AND** no flow SHALL start

#### Scenario: A flow is already running

- **WHEN** `flow:run` arrives while a flow is active
- **THEN** the engine SHALL emit `flow:complete` with `status: "rejected"` and `reason` equal to the command path's "already running (X)" message naming the active flow
- **AND** the in-flight run SHALL be unaffected and the new one SHALL NOT start

#### Scenario: Blocked by a registered gate

- **WHEN** `flow:run` targets a flow whose registered gate is not satisfied
- **THEN** the engine SHALL emit `flow:complete` with `status: "rejected"` and `reason` equal to the gate message
- **AND** no flow SHALL start

#### Scenario: Renderable without a prior flow_started

- **WHEN** a consumer that never observed `flow_started` receives the terminal rejection
- **THEN** it SHALL be able to render the outcome from `status === "rejected"` and `reason` alone

### Requirement: Concurrent dispatch cannot start two runs in one process

The check that a flow is already running and the marking of a run as active SHALL be atomic with respect to `flow:run` dispatch: the engine SHALL mark a run active before any `await` that precedes the assignment of the active-run record, so that a second `flow:run` arriving before the first `start()` resolves observes the run as active and is declined. Two `flow:run` events SHALL NOT produce two concurrent runs in one process. The now-reachable "already running" throw from the start routine SHALL be handled and surfaced as the same terminal rejection, never as an unhandled promise rejection.

#### Scenario: Two dispatches in the race window

- **WHEN** two `flow:run` events are dispatched back-to-back before the first `start()` resolves
- **THEN** exactly one run SHALL start
- **AND** the second SHALL be declined (its `start()` throwing "already running")
- **AND** no unhandled promise rejection SHALL be raised

### Requirement: The start path is behaviourally unchanged and still declines

A `flow:run` that starts a flow SHALL behave as before — the run identity carried on the flow's own lifecycle events is the only addition. The already-running case SHALL still **decline**; this requirement does not introduce queueing or deferred execution.

#### Scenario: Already-running still declines, does not queue

- **WHEN** `flow:run` arrives while a flow is active
- **THEN** the new dispatch SHALL be declined (a terminal rejection), not queued or deferred for later execution
