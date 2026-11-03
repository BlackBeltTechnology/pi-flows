# Tasks

Order per AGENTS.md: write the FAILING test from the spec scenario, confirm it fails, then implement. Integration tests that need a real daemon use `describe.skipIf(!dockerAvailable)`.

## 1. Spike: tool override in agent sessions (D1)

- [ ] 1.1 Write a test with the faux harness: an agent extension factory registers a `read` tool that returns a sentinel; the agent's `read` call returns the sentinel (override wins over the SDK built-in) and an undeclared tool is still blocked by the guard. Record the result in design.md D1; if the override does not win, switch D1 to the fallback and update tasks before continuing.

## 2. Remove `access:` (D8)

- [ ] 2.1 Add failing tests: validating an agent with `access:` reports an error mentioning `flows.sandbox`; parsing ignores the block; guard no longer blocks reads/writes by path. Verify they fail.
- [ ] 2.2 Delete `AccessRules`, `parseAccessBlock`, the guard access branch and the skill-glob widening in `execution.ts`; add the validator error. Verify 2.1 passes and `npm test` stays green (update/remove tests that asserted the old access behavior).

## 3. Settings and mode resolution (D6)

- [ ] 3.1 Add failing tests: default `none`; settings `docker` → docker; flow `sandbox: docker` → docker; settings `docker` + flow `sandbox: none` → docker; project overrides global; invalid values → validation error / warning. Verify they fail.
- [ ] 3.2 Implement the `flows.sandbox` reader (reuse edit-flow-config lookup) and flow `sandbox:` parsing. Verify 3.1 passes.

## 4. Docker CLI layer and container lifecycle (D2)

- [ ] 4.1 Add failing unit tests with a fake CLI: `run` arguments contain every flag from D2 (incl. `--user`, read-only, no network, labels, project and read-only skill mounts; Podman uses `--userns=keep-id`); `rm -f` is called on success, error, abort and timeout. Verify they fail.
- [ ] 4.2 Implement `sandbox/docker-cli.ts` (spawn helpers with timeouts) and `sandbox/container.ts` (start/exec/stop). Verify 4.1 passes.
- [ ] 4.3 Add failing test + implement stale-container cleanup on `session_start` (labelled, older than max run time). Verify.

## 5. Container-backed tools (D1, D3, D4)

- [ ] 5.1 Add failing unit tests (fake CLI): each operation maps to the documented exec command; `bash` streams output, honors timeout and abort (follow-up kill exec). Verify they fail.
- [ ] 5.2 Implement operations for `read`/`write`/`edit`/`ls` and `bash`, plus container `grep` (rg, fallback `grep -rn`) and `find` tools with pi's parameter schemas, registered by `createDockerSandboxExtension`. Verify 5.1 passes.
- [ ] 5.3 Wire the extension into `spawnAgent` when the effective backend is `docker` (agent steps, fork decision agents, agent-decision agents). Verify with a faux-harness test using the fake CLI that all seven tool calls go through the CLI and none touch host fs.

## 6. Preflight and diagnostics (D5)

- [ ] 6.1 Add failing tests (fake CLI / env stubs) for each failure row in D5: CLI missing, daemon down (context named), socket EACCES, image pull failure, folder not shareable, native Windows; arch mismatch → warning only; flow does not start and no agent session is created on failure. Verify they fail.
- [ ] 6.2 Implement `sandbox/preflight.ts` with per-OS fix messages, call it once per flow run before the first sandboxed agent, and register `/flows:sandbox doctor`. Verify 6.1 passes.
- [ ] 6.3 Emit `flow:sandbox-status` per sandboxed agent run (run id, step id, backend, CLI, image, container id). Verify with an event test.

## 7. Extension tools in docker mode (D7)

- [ ] 7.1 Add failing tests: untrusted extension tool → step fails naming the tool and `flows.sandbox.trustedTools`; trusted tool → available. Verify they fail.
- [ ] 7.2 Implement in `filterExtensionTools` / step start. Verify 7.1 passes.

## 8. Real-Docker escape suite (D9)

- [ ] 8.1 Add integration tests (skipIf no docker) driving a sandboxed agent through the faux harness: `cat ../outside.txt` fails; `ls ~/.ssh` path absent; write to `/evil` fails; outbound connection fails; `ln -s /etc/passwd link` + `read link` returns container content; created file owned by host uid; skill `SKILL.md` readable, not writable; no `pi-flows.run` container remains after abort. Verify all pass locally with Docker running.
- [ ] 8.2 Run `security-hardening` and `doubt-driven-review` over the sandbox code and the escape suite; record findings or "none" here.

## 9. Docs

- [ ] 9.1 Delegate to a subagent: new `docs/security.md` (pi-flows is not a boundary by itself; docker sandbox setup per OS; gVisor for untrusted input; trusted tools; code steps are host code); update `docs/agents.md` / `docs/flow-authoring.md` (remove `access:`, migration), `docs/flows.md` (`sandbox:`), `docs/events-api.md` (`flow:sandbox-status`); add pointer in AGENTS.md Documentation Pointers. Verify every new example validates.
- [ ] 9.2 Update `skills/manage-flows/SKILL.md` (remove `access:`, mention `sandbox:`), README (settings + `/flows:sandbox doctor`), CHANGELOG (feature + BREAKING `access:`). Verify by reading.

## 10. Integration check

- [ ] 10.1 `npm run lint && npm run typecheck && npm test` green (docker suite runs locally, skipped in CI without Docker).
- [ ] 10.2 Manual: run a starter flow with `flows.sandbox.backend: "docker"` on macOS (Docker Desktop) and Linux; stop the daemon and confirm the flow refuses to start with the documented message; `/flows:sandbox doctor` shows each check.

## Workflow follow-up

- Archive the change after review.
