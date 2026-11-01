## Purpose

Confine a flow agent's built-in tools to a per-run Docker container that sees only the project folder, so no command or file operation the agent issues can read or change anything else on the host, and refuse to run when that confinement cannot be set up.

## ADDED Requirements

### Requirement: Sandbox backend is configured in settings and may be required by a flow

pi-flows SHALL read `flows.sandbox` from global and project settings (project overrides global) with `backend` `"none"` (default) or `"docker"`. A flow MAY declare top-level `sandbox: docker` to require the docker backend. A flow SHALL NOT be able to weaken the settings: when settings select `docker`, a flow declaring `sandbox: none` SHALL still run sandboxed.

#### Scenario: Default is unchanged behavior

- **GIVEN** no `flows.sandbox` setting and a flow without `sandbox:`
- **WHEN** the flow runs
- **THEN** agents SHALL run their tools on the host as before

#### Scenario: Flow requires docker

- **GIVEN** no `flows.sandbox` setting and a flow declaring `sandbox: docker`
- **WHEN** the flow runs
- **THEN** its agents SHALL run in the docker sandbox

#### Scenario: Flow cannot weaken settings

- **GIVEN** `flows.sandbox.backend: "docker"` and a flow declaring `sandbox: none`
- **WHEN** the flow runs
- **THEN** its agents SHALL run in the docker sandbox

### Requirement: Each sandboxed agent run gets its own confined container

In docker mode, pi-flows SHALL start one container per agent run using the configured CLI and image, and remove it when the run ends (success, failure, abort or timeout). The container SHALL mount the project folder read-write at the same absolute path and SHALL NOT mount any other host path except declared skill directories (read-only).

#### Scenario: Only the project folder is visible

- **GIVEN** a sandboxed agent whose project folder is `/p/work` and a host file `/p/outside.txt`
- **WHEN** the agent runs `cat /p/outside.txt` or `cat ../outside.txt` with `bash`
- **THEN** the command SHALL fail because the file does not exist in the container

#### Scenario: Home and credentials are not visible

- **WHEN** a sandboxed agent runs `ls ~/.ssh` or reads any path under the host user's home outside the project folder
- **THEN** the path SHALL NOT exist in the container

#### Scenario: Writes outside the folder fail

- **WHEN** a sandboxed agent writes to `/evil` or any path outside the project folder and the temporary directory
- **THEN** the write SHALL fail

#### Scenario: Container is removed after the run

- **WHEN** a sandboxed agent run ends for any reason, including abort
- **THEN** no container started for that run SHALL remain

### Requirement: Sandbox containers are hardened

Each sandbox container SHALL run as the host user's uid and gid, with no network unless `network: "bridge"` is configured, a read-only root filesystem with a writable temporary directory, all capabilities dropped, no privilege escalation, and process and memory limits.

#### Scenario: No network by default

- **WHEN** a sandboxed agent runs a command that opens an outbound connection
- **THEN** the connection SHALL fail

#### Scenario: Files written in the folder belong to the host user

- **WHEN** a sandboxed agent creates `made.txt` in the project folder
- **THEN** the file SHALL exist on the host owned by the host user

### Requirement: All built-in tools run inside the container

In docker mode, the agent's `bash`, `read`, `write`, `edit`, `ls`, `grep` and `find` tools SHALL execute inside the agent's container. No built-in tool SHALL read or write host files directly for a sandboxed agent. Model calls and credentials SHALL remain in the host process.

#### Scenario: Symlink created by bash cannot leak a host file

- **GIVEN** a sandboxed agent that runs `ln -s /etc/passwd link` in the project folder
- **WHEN** the agent uses the `read` tool on `link`
- **THEN** the content returned SHALL be the container's `/etc/passwd`, not the host's

#### Scenario: grep and find search inside the container

- **GIVEN** a sandboxed agent
- **WHEN** it calls `grep` or `find` on `/`
- **THEN** results SHALL contain only paths that exist in the container

### Requirement: Host-executed extension tools are excluded unless trusted

In docker mode, extension and MCP tools (which execute on the host) SHALL NOT be offered to a sandboxed agent unless listed in `flows.sandbox.trustedTools`. An agent that declares such a tool SHALL see an error at run start naming the tool and the setting. `code` steps SHALL continue to run on the host as trusted flow code.

#### Scenario: Untrusted extension tool is refused

- **GIVEN** docker mode and an agent declaring extension tool `web_fetch` not in `trustedTools`
- **WHEN** the agent step starts
- **THEN** the step SHALL fail with an error naming `web_fetch` and `flows.sandbox.trustedTools`

#### Scenario: Trusted extension tool is allowed

- **GIVEN** docker mode and `trustedTools: ["web_fetch"]`
- **WHEN** the agent declares `web_fetch`
- **THEN** the tool SHALL be available and run on the host

### Requirement: Sandboxed flows fail closed when the environment is not ready

Before the first sandboxed agent of a flow run starts, pi-flows SHALL verify: the CLI exists, the daemon responds, the project folder can be mounted, and the image is present or can be pulled. If any check fails, the flow SHALL NOT start and SHALL fail with a message naming the failed check and a fix for the current OS. pi-flows SHALL NOT fall back to running the agent on the host. An image whose architecture differs from the host SHALL produce a warning, not a failure.

#### Scenario: Docker not installed

- **GIVEN** docker mode and no `docker` executable on PATH
- **WHEN** a flow starts
- **THEN** it SHALL fail before any agent runs, with a message telling the user how to install Docker for their OS

#### Scenario: Daemon not running

- **GIVEN** docker mode and a CLI whose daemon does not respond
- **WHEN** a flow starts
- **THEN** it SHALL fail with a message naming the active Docker context and how to start it

#### Scenario: Folder not shareable

- **GIVEN** docker mode and a project folder the daemon cannot mount
- **WHEN** a flow starts
- **THEN** it SHALL fail with a message naming the folder and the file-sharing fix

#### Scenario: Image missing and pull fails

- **GIVEN** docker mode, an image not present locally and a failing pull
- **WHEN** a flow starts
- **THEN** it SHALL fail with a message naming the image

### Requirement: Sandbox diagnostics are available on demand and per run

pi-flows SHALL register `/flows:sandbox doctor`, which runs the preflight checks without starting a flow and prints each check's result and fix. Each sandboxed agent run SHALL emit `flow:sandbox-status` with the run id, step id, backend, CLI, image and container id.

#### Scenario: Doctor reports a healthy setup

- **GIVEN** a working Docker installation
- **WHEN** the user runs `/flows:sandbox doctor`
- **THEN** every check SHALL be reported as passed

#### Scenario: Status event per sandboxed run

- **WHEN** a sandboxed agent run starts
- **THEN** a `flow:sandbox-status` event SHALL be emitted with backend `docker` and the container id

### Requirement: Declared skills stay readable in the sandbox

In docker mode, each resolved skill directory of an agent SHALL be mounted read-only into its container at the same absolute path, so the advertised `SKILL.md` and topic files are readable with `read`.

#### Scenario: Skill file readable, not writable

- **GIVEN** a sandboxed agent declaring skill `docs-x` located outside the project folder
- **WHEN** the agent reads the skill's `SKILL.md` and then tries to write to it
- **THEN** the read SHALL succeed and the write SHALL fail

### Requirement: The agent `access:` block is rejected

Agent validation SHALL report an error when an agent declares `access:`, stating that pi-flows does not restrict paths in-process and pointing to `flows.sandbox`. Agent parsing SHALL ignore the block.

#### Scenario: Declaring access fails validation

- **WHEN** an agent with an `access:` block is validated
- **THEN** validation SHALL report an error that mentions `flows.sandbox`
