## ADDED Requirements

### Requirement: Run and per-node state is persisted
The engine SHALL persist, for every run, its identity and lifecycle status and,
per node, the node's status — one of `pending`, `running`, `finished`, or
`upcoming` — together with that node's produced output values. Persistence
SHALL cover both in-progress and completed runs and survive beyond the run's
in-memory lifetime.

#### Scenario: in-progress run state is recorded
- **WHEN** a run is executing and node `a` has finished while node `b` is running
- **THEN** the persisted state reports `a: finished` (with its outputs) and `b: running`

#### Scenario: completed run state is retained
- **WHEN** a run has ended
- **THEN** its final per-node statuses and produced values remain queryable after the run is no longer in memory

### Requirement: A read-only seam exposes run state
The engine SHALL expose run and per-node state through a read-only seam (a query
API and/or events) that an external consumer can call to list runs and read a
run's nodes, their statuses, and their produced values. The seam SHALL serve
both live and historical runs.

#### Scenario: list runs
- **WHEN** a consumer queries for runs
- **THEN** it receives the live and recent runs with their identity and status

#### Scenario: read a run's node state
- **WHEN** a consumer queries a specific run
- **THEN** it receives each node's status and produced output values

### Requirement: The exposure seam cannot mutate a run
The read-only seam SHALL provide no operation that alters a run, a node, or a
result. Reading run state SHALL have no side effect on execution.

#### Scenario: no write path exists
- **WHEN** a consumer uses the exposure seam
- **THEN** there is no call that resumes, re-routes, overrides, or otherwise changes the run; the seam is strictly read-only
