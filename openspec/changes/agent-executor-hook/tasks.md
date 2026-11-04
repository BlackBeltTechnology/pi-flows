# Tasks

Every group starts with a failing test derived from the spec. Reuse code from branch `os/agent-docker-sandbox` where it fits.

## 1. Registry and selection

- [ ] 1.1 Failing tests: `flow:register-executor` registers; `host` reserved and duplicate names rejected with a warning; precedence (flow `executor:` vs `flows.executor` vs `host`); flow cannot weaken settings; unknown executor fails before the first step, listing registered names
- [ ] 1.2 Implement `executor/registry.ts`, settings keys `flows.executor` and `flows.trustedTools`, `executor:` on `FlowConfig`

## 2. Operations over spawn

- [ ] 2.1 Failing tests with a fake executor recording argv: all seven tools go through `spawn`; paths with metacharacters arrive as single argv elements; `bash` streams `onData`; the symlink scenario reads via `spawn`, not host fs
- [ ] 2.2 Implement `executor/operations.ts` (generalize `sandbox/operations.ts`), wire `TOOL_FACTORIES` to use them for non-host executors

## 3. Lifecycle and preflight

- [ ] 3.1 Failing tests: preflight once per run, a failure stops the flow with check/message/fix and no agent started; lazy `setup` on first tool call; `teardown` exactly once on success, error, abort and timeout; `setup` failure → soft step failure
- [ ] 3.2 Implement in `spawnAgent` and the flow runner; `/flows:executor doctor`

## 4. Host-side tool policy and events

- [ ] 4.1 Failing tests: undeclared-trust extension tool fails at step start naming the tool and `flows.trustedTools`; trusted tool allowed; `flow:executor-status` setup/teardown events; card shows the executor
- [ ] 4.2 Implement

## 5. Remove access:

- [ ] 5.1 Failing tests: agent with `access:` fails validation pointing to `flows.executor`; guard has no path checks; skill dirs no longer widen read rules
- [ ] 5.2 Delete the `access:` parsing, guard path checks and skill-dir whitelisting; update shipped agents and tests

## 6. Docker reference executor (example)

- [ ] 6.1 Failing tests with a fake CLI runner: container args (project mount at same path, `--network none`, `--read-only`, `--cap-drop ALL`, uid/gid, limits, skill dirs read-only); preflight per-OS fixes; stale-container cleanup; not registered unless loaded
- [ ] 6.2 Implement `examples/executors/docker/` reusing `container.ts`, `docker-cli.ts`, `preflight.ts`; README with load instructions
- [ ] 6.3 Integration test gated by `PI_FLOWS_DOCKER_TESTS=1` (symlink escape, outside read, network, uid) — written, run by the operator
- [ ] 6.4 Manual (operator): load the example on macOS and Linux, run `/flows:executor doctor` and one flow; stop the daemon and confirm the flow refuses to start

## 7. Docs and gates

- [ ] 7.1 Subagent: `docs/security.md` (new), `docs/agents.md`, `docs/architecture.md`, `docs/events-api.md`, `docs/extending-pi-flows.md` (writing an executor)
- [ ] 7.2 `README.md`, `CHANGELOG.md` (breaking `access:` removal)
- [ ] 7.3 `npm run lint && npm run typecheck && npm test`
