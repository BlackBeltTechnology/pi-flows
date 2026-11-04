# Spec Delta

## Purpose

Lets users decide where flow agents' built-in tools execute by registering an executor (a process-spawn hook with preflight and lifecycle), so isolation is pluggable and pi-flows contains no OS- or runtime-specific logic.

## ADDED Requirements

### Requirement: Executors are registered by event

pi-flows SHALL accept `flow:register-executor { name, executor }` where `executor` provides `preflight`, `setup`, `spawn` and `teardown`. The name `host` SHALL be reserved for the built-in executor that runs tools on the host as today. Registering a reserved or already-registered name SHALL be rejected with a warning naming it.

#### Scenario: Extension registers an executor
- **WHEN** an extension emits `flow:register-executor` with name `docker` and a valid executor
- **THEN** `flows.executor: "docker"` SHALL select it

#### Scenario: Reserved name rejected
- **WHEN** an extension registers an executor named `host`
- **THEN** the registration SHALL be ignored with a warning

### Requirement: All built-in tools run through the selected executor

With a non-host executor, every built-in tool of a flow agent (`bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`) SHALL execute through that executor's `spawn`, with arguments passed as an argv array and never interpolated into a shell string. No built-in tool of that agent SHALL access the host filesystem directly.

#### Scenario: Symlink planted by bash is not followed on the host
- **GIVEN** an isolating executor AND the agent runs `ln -s /etc/passwd link` with `bash`
- **WHEN** the agent calls `read` on `link`
- **THEN** the read SHALL be executed by `spawn` inside the executor AND SHALL NOT return the host's `/etc/passwd`

#### Scenario: File paths with shell metacharacters
- **WHEN** the agent writes to a file named `a; rm -rf x`
- **THEN** `spawn` SHALL receive the path as a single argv element

### Requirement: Executor selection precedence and fail-closed behaviour

The executor SHALL be the flow's `executor:` when settings select `host`, else the `flows.executor` setting (project overrides global), else `host`. A flow SHALL NOT replace a non-host executor chosen in settings with `host`. An unknown executor name SHALL fail the flow before any step runs, with an error naming the executor and listing registered ones.

#### Scenario: Flow requires an executor
- **GIVEN** settings select `host` AND a flow declares `executor: docker` AND `docker` is registered
- **WHEN** the flow runs
- **THEN** its agents' tools SHALL run through `docker`

#### Scenario: Flow cannot weaken settings
- **GIVEN** `flows.executor: "docker"` AND a flow declares `executor: host`
- **WHEN** the flow runs
- **THEN** its agents' tools SHALL run through `docker`

#### Scenario: Unknown executor
- **GIVEN** `flows.executor: "bwrap"` and no executor named `bwrap`
- **WHEN** a flow starts
- **THEN** the flow SHALL fail before its first step with an error naming `bwrap` and the registered executors

### Requirement: Preflight runs once per flow run and fails closed

Before the first agent of a run with a non-host executor, pi-flows SHALL call `preflight` once. A failed preflight SHALL stop the flow before any agent starts, with the executor's `check`, `message` and `fix`. pi-flows SHALL NOT fall back to the host. `/flows:executor doctor` SHALL run the selected executor's preflight and print its result.

#### Scenario: Preflight failure stops the flow
- **WHEN** the executor's preflight returns `{ ok: false, check: "daemon", message: "not running", fix: "colima start" }`
- **THEN** the flow SHALL end with an error containing `daemon`, `not running` and `colima start` AND no agent SHALL have run

#### Scenario: Doctor command
- **WHEN** the user runs `/flows:executor doctor`
- **THEN** the selected executor's preflight result SHALL be shown, including the fix on failure

### Requirement: Executor lifecycle per agent run

pi-flows SHALL call `setup` once before an agent's first tool call and `teardown` exactly once after the agent run ends, whether it succeeds, fails, is aborted or times out. A `setup` failure SHALL fail the step softly with the executor's message.

#### Scenario: Teardown on abort
- **WHEN** the user aborts a flow while a sandboxed agent is running
- **THEN** `teardown` SHALL be called for that agent's handle

#### Scenario: Setup failure
- **WHEN** `setup` throws `image pull failed`
- **THEN** the step SHALL fail softly with a message containing `image pull failed`

### Requirement: Host-side tools need explicit trust

With a non-host executor, an agent that declares an extension or MCP tool SHALL fail at step start, naming the tool and `flows.trustedTools`, unless the tool is listed in `flows.trustedTools`. `code` steps SHALL run on the host as trusted flow code.

#### Scenario: Untrusted extension tool
- **GIVEN** a non-host executor AND an agent with `tools: [read, web_search]` AND `web_search` not in `flows.trustedTools`
- **WHEN** the step starts
- **THEN** it SHALL fail with an error naming `web_search` and `flows.trustedTools`

### Requirement: Executor status is reported

Each agent run under a non-host executor SHALL emit `flow:executor-status { runId, stepId, executor, phase, ok, message? }` for `setup` and `teardown`, and the agent card SHALL show the executor name.

#### Scenario: Status event on setup
- **WHEN** a sandboxed agent's executor setup succeeds
- **THEN** `flow:executor-status` SHALL be emitted with `phase: "setup"` and `ok: true`

### Requirement: The access block is rejected

An agent file that declares `access:` SHALL fail validation with an error stating that `access:` is removed and pointing to `flows.executor`.

#### Scenario: Legacy access block
- **WHEN** an agent declares `access: { bash: { deny: ["git push*"] } }`
- **THEN** agent validation SHALL report an error mentioning `flows.executor`

### Requirement: A Docker reference executor ships as an example

pi-flows SHALL ship a Docker executor example, loadable as an extension, that registers `docker` and runs each agent in its own container with only the project folder mounted at the same absolute path, no network by default, a read-only root filesystem, all capabilities dropped, the host uid/gid and resource limits. It SHALL NOT be registered unless the user loads it.

#### Scenario: Example not active by default
- **GIVEN** pi-flows installed without loading the Docker example
- **WHEN** settings select `flows.executor: "docker"`
- **THEN** the flow SHALL fail as an unknown executor
