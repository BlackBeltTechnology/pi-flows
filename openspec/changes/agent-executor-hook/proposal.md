# Proposal: agent-executor-hook

## Why

Flow agents run pi's built-in tools on the host with the user's permissions. The agent `access:` block that was meant to limit them never took effect and cannot confine `bash` in any case. The earlier `agent-docker-sandbox` proposal hard-coded Docker into the core, together with its OS-specific setup checks. Users run very different isolation tools (Docker, Podman, OrbStack, Colima, bubblewrap, firejail, an SSH box, a VM), and pi-flows should not have to know any of them.

pi already lets every built-in tool take a replacement backend (`operations`). A probe showed the backend must cover **all seven** tools: if only `bash` is isolated, the agent can create `link -> /etc/passwd` in the shared folder and a host-side `read` follows it. All seven can be built on top of one primitive, *spawn a process inside the isolation boundary*, so the hook the user implements is just process spawning plus lifecycle.

## What Changes

- **Executor hook.** An extension registers an executor with `flow:register-executor { name, executor }`, where `executor` is:
  - `preflight(ctx) → { ok: true } | { ok: false, check, message, fix }`
  - `setup(run) → handle` (once per agent run; `run` has the project dir, flow and step ids, skill dirs, `signal`)
  - `spawn(handle, argv, { cwd, env, stdin, signal, timeoutMs }) → { code, stdout, stderr }` (with streaming `onData` for `bash`)
  - `teardown(handle)` (always called: success, error, abort, timeout)
- **pi-flows builds all seven built-in tools on `spawn`:** `bash` streams through it; `read`, `write`, `edit`, `ls`, `grep` and `find` are implemented as spawned commands (`cat`, `tee`, `ls`, `rg`/`grep`, `find`) passing arguments as argv, never through a shell string. Nothing touches the host filesystem for that agent.
- **Selection:** setting `flows.executor` (a registered name, default `host` = today's behaviour) with project overriding global. A flow can require one with `executor: <name>`. A flow can never weaken the settings. An unknown executor name **fails the flow**; pi-flows never silently falls back to the host.
- **Preflight:** run once per flow run before the first agent of a non-host executor. A failure stops the flow with the executor's message and fix. `/flows:executor doctor` runs it on demand.
- **Host-side tools:** extension and MCP tools run on the host. With a non-host executor an agent that declares one fails at step start unless the tool is listed in `flows.trustedTools`. `code` steps are trusted host code.
- **Visibility:** `flow:executor-status { runId, stepId, executor, phase, ok, message? }` per agent run; the agent card shows the executor name.
- **Reference executor, not core:** a **Docker executor example** ships under `examples/executors/docker/` (per-run container, only the project folder mounted at the same path, `--network none`, `--read-only`, `--cap-drop ALL`, host uid/gid, limits, stale-container cleanup, per-OS preflight messages). Users load it as an extension or copy it. The implementation on branch `os/agent-docker-sandbox` is reused for it.
- **BREAKING: the agent `access:` block is removed.** Declaring it is a validation error that points to `flows.executor`. The skill-directory widening of `access.read` and the guard's path checks are deleted.
- **New `docs/security.md`:** pi-flows is not a security boundary; isolation comes from an executor; how to write one; the Docker example.

## Capabilities

### New Capabilities
- `agent-executor`: executor registration, the spawn-based tool backends, selection precedence, fail-closed preflight, host-side tool policy, status events, doctor command, Docker reference example.

### Modified Capabilities
- `agent-skills`: the `access.read` skill-directory whitelisting and read-denial requirements are removed.

## Impact

- **Code:** new `extensions/flow-engine/executor/` (registry, spawn-backed operations, tool factory), `execution.ts` (`TOOL_FACTORIES` take operations from the selected executor), settings helper, `index.ts` (events, `/flows:executor doctor`), agent parser/validator (`access:` error), guard path checks removed, `examples/executors/docker/`.
- **Docs:** `docs/security.md` (new), `docs/agents.md`, `docs/architecture.md`, `docs/events-api.md`, `docs/extending-pi-flows.md`, `README.md`, `CHANGELOG.md`.
- **Supersedes** `agent-docker-sandbox` (removed).
- **Depends on** `resolver-agnostic-model-refs` (shared settings helper).

## Discipline Skills

`security-hardening` (isolation boundary, argv-only spawning, fail closed), `doubt-driven-review` (breaking `access:` removal, public hook API), `observability-instrumentation` (executor status events).
