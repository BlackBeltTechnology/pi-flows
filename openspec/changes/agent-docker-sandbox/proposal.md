## Why

Flow agents run their tools directly on the host with the user's full permissions. The only restriction pi-flows advertises — the agent `access:` block — has never worked (it parses to nothing) and could not work: it is an in-process path check that any `bash` command bypasses. pi itself has no sandbox and states that safety comes only from an OS or virtualization boundary (`docs/security.md`). Users who run flows on real repositories, or apps that run flows for many users, need a way to confine an agent to one folder so no command it writes can read or change anything else.

A spike on macOS (Docker Desktop) confirmed the approach and its one pitfall: a container that mounts only the project folder blocks every escape attempted (`../`, `~/.ssh`, other languages, rootfs writes, network), but if only `bash` runs in the container, the agent can create `link -> /etc/passwd` in the shared folder and pi's host-side `read` tool follows it to the host file. All file tools must therefore run inside the container too.

## What Changes

- **New opt-in Docker sandbox for flow agents.** With `flows.sandbox.backend: "docker"`, each agent run gets its own container started from the Docker (or Podman) already installed on the machine. Only the project folder is mounted (read-write, at the same absolute path); the container has no network by default, runs as the host user, has a read-only root filesystem, dropped capabilities and process/memory limits, and is removed when the agent finishes.
- **All seven built-in tools run inside the container**: `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`. Model calls and API keys stay in the host pi process.
- **Fail closed.** A preflight check runs before a sandboxed flow starts (Docker CLI, daemon, folder shareable, image available, architecture). If it fails, the flow does not start and the error names the fix for the user's OS. pi-flows never silently runs a sandboxed flow on the host.
- **`/flows:sandbox doctor` command** runs the same checks on demand and prints per-OS fixes; a `flow:sandbox-status` event reports the backend used per run.
- **Settings**: `flows.sandbox` with `backend` (`none` default | `docker`), `image`, `network` (`none` | `bridge`), `cli` (`docker` | `podman`), `trustedTools` (extension tools allowed on the host in docker mode), resource limits. A flow may declare `sandbox: docker` to require it; a flow cannot weaken the settings.
- **Extension and MCP tools** are not available to sandboxed agents unless listed in `trustedTools` (they would run on the host). `code` steps remain trusted host code.
- **BREAKING: the agent `access:` block is removed.** Declaring it is a validation error that points to `flows.sandbox`. The skill-directory widening of `access.read` and the guard's path checks are deleted; in docker mode, declared skill directories are mounted read-only instead.

## Capabilities

### New Capabilities
- `agent-docker-sandbox`: confining a flow agent's built-in tools to a per-run Docker container that sees only the project folder — configuration, container lifecycle, tool routing, preflight and diagnostics, and fail-closed behavior.

### Modified Capabilities
- `agent-skills`: the two `access.read` requirements (skill-directory whitelisting, read-denial reporting) are removed with the `access:` block; in docker mode, skill files stay readable because their directories are mounted read-only.

## Impact

- **Code**: new `extensions/flow-engine/sandbox/` (docker backend, preflight, container-backed tool operations and grep/find tools, doctor command); `extensions/flow-engine/execution.ts` (attach the sandbox to agent sessions, remove access/skill-glob widening); `extensions/flow-engine/guard.ts` (remove access-rule enforcement); `extensions/flow-engine/agent-parser.ts` + `tools/agent-validate.ts` (drop `access`, validation error); `extensions/flow-engine/flow-parser-yaml.ts` (flow `sandbox:`); settings reader; `flow-execution.ts` (extension-tool filtering in docker mode).
- **Dependencies**: none new at runtime — the Docker/Podman CLI is invoked as a child process. Tests needing a real daemon are skipped when Docker is unavailable.
- **Users**: no change unless they opt in. Agents declaring `access:` fail validation (they were never restricted anyway); CHANGELOG explains.
- **Platforms**: macOS (Docker Desktop, OrbStack, Colima), Linux (Docker, rootless Docker, Podman), Windows (Docker Desktop with WSL2). Plain Docker shares the host kernel; docs point to gVisor (`runtime: runsc`) for untrusted multi-user input.
- **Docs**: new `docs/security.md`; `docs/agents.md`, `docs/flow-authoring.md`, `docs/flows.md`, `skills/manage-flows/SKILL.md`, README (docs/ via subagent per AGENTS.md).

## Discipline Skills

`security-hardening` (untrusted model-generated commands, container escape paths), `doubt-driven-review` (BREAKING removal of `access:`, fail-closed semantics), `observability-instrumentation` (sandbox status events, preflight diagnostics), `systematic-debugging` for cross-OS Docker failures.
