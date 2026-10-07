## TDD rules for this change

- Every behaviour task is a **RED → GREEN** pair. Write the test from the spec scenario alone, run it, and **record that it fails for the expected reason** before touching production code.
- Tests are based on the spec. They assert observable outcomes (the agent succeeds or fails, the error text, the session options pi receives), not internal variable names.
- **No harness shortcuts.** The faux harness (`spawnFaux`/`runFaux`) passes `modelRuntime` explicitly, and that is exactly why the bug was hidden. Every RED test below must enter through the **production wiring** (the extension's `session_start` → FlowManager → `runFlow` → `spawnAgent`). The only test double allowed is a real pi `ModelRuntime` holding a faux provider, wrapped in a **real** `new ModelRegistry(runtime)`.
- Fixture used everywhere (create it in 1.1): `makeParentSession()` builds a real `ModelRuntime` (`modelsPath: null`, `allowModelNetwork: false`), registers a faux provider `rtprov` **only in memory** (it is not in any `models.json`/`auth.json`), wraps it in `new ModelRegistry(runtime)`, and returns `{ ctx: { modelRegistry }, runtime, faux }`.
- Run the suite with `npx vitest run <file>`. Gate on full `npm run lint && npm run typecheck && npm test` at the end of each group.

## 1. Test fixtures (no production change)

- [x] 1.1 Add `__tests__/helpers/parent-session.ts` with `makeParentSession()` (see above) plus `fakeExtensionHost()`, which captures `pi.on`/`pi.events.on` handlers so the real extension entry can be driven (`fire("session_start", ctx)`, `emit("flow:get-spawn-context", data)`). Verify with a smoke test that `ctx.modelRegistry.find("rtprov", id)` returns the model and `hasConfiguredAuth` is true.
- [x] 1.2 Add a `createAgentSession` spy helper (wrap the real function with `vi.spyOn` on the SDK module, or inject it via the existing seam if one exists) that records the options object of every call and still delegates to the real implementation. Verify that a faux spawn records exactly one call.

## 2. RED: runtime inheritance (spec: subagent-spawn)

Create `__tests__/flow-runtime-inheritance.test.ts`. Write all of these, run them, and confirm each fails as noted.

- [x] 2.1 **Runtime-registered provider is usable by a flow agent.** Fire `session_start` with `makeParentSession().ctx`, then run a one-agent flow through the production path. The agent uses `model: rtprov/m1` and is scripted with `scriptFinish`. Expect: success, and the faux provider received exactly 1 request. *Expected RED:* fails with "No API key found"/"Unknown provider: rtprov".
- [x] 2.2 **Same runtime object is used.** Using the spy from 1.2, expect `createAgentSession` options `.modelRuntime === runtime` (identity, not just shape). *Expected RED:* the key is absent.
- [x] 2.3 **Provider registered AFTER session_start is visible.** Fire `session_start` first, then `runtime.registerNativeProvider(late)`, then run an agent on `late/m1`. Expect success. *Expected RED:* fails like 2.1. Guards against copying or snapshotting the runtime.
- [x] 2.4 **Every spawn path gets the runtime.** Write one test per path, each asserting `.modelRuntime === runtime` on every recorded call:
  - (a) a plain agent step
  - (b) an autonomous fork decision agent
  - (c) an `agent-decision` step that loops back once, so it runs twice

  *Expected RED:* all fail. This covers the three `flow-execution` pass-through sites.
- [x] 2.5 **Removed options are never sent.** For every recorded call, expect no `authStorage` and no `modelRegistry` key. *Expected:* may already pass. Keep it as a regression guard and note its status.
- [x] 2.6 **Model is never inherited.** The parent's current model is `rtprov/m1`.
  - (a) An agent with `model: rtprov/does-not-exist` fails with a resolution error that names the ref. Expect zero `createAgentSession` calls and zero faux requests.
  - (b) An agent with `model: "@coding"` and no `model:resolve` handler fails with the "requires a model:resolve handler" error.
  - (c) An agent whose `model:` is missing or empty fails with a resolution error.

  *Expected:* passes before and after. A pinned invariant. Run it before and after the change.
- [x] 2.7 **Resolution via `model:resolve` still gets the runtime.** Register a fake `model:resolve` handler that answers `@fast → rtprov/m1` (returning `probe.model` from the parent registry). Expect success, and `.modelRuntime === runtime`. *Expected RED.*
- [x] 2.8 **No parent session means default runtime.** Run `runFlow` programmatically with no `session_start` and no `modelRuntime`. Expect `createAgentSession` called **without** a `modelRuntime` key, and an agent on `rtprov/m1` fails with the provider error. *Expected:* passes today. It pins the fallback contract.
- [x] 2.9 **`flow:get-spawn-context` exposes the runtime.** After `session_start`, emit the event with `{}`. Expect `data.modelRuntime === runtime`, `data.modelRegistry === ctx.modelRegistry`, and no `authStorage` key. *Expected RED.*
- [x] 2.10 **Session switch replaces the runtime.** Fire `session_start` with parent A, then with parent B. A run must use B's runtime, and must not use A's after the switch. *Expected RED.*

## 2b. RED: no-dashboard fallback resolves via the session registry (spec: flow-model-resolution)

- [x] 2b.1 Production path, no `model:resolve` handler, fake host `pi` has NO `modelRegistry`: an agent on `rtprov/m1` resolves (no "Model registry unavailable"). *Expected RED:* exactly that error.
- [x] 2b.2 Same with a bare id `m1`. *Expected RED.*
- [x] 2b.3 Unknown literal still fails with the unknown-model error naming the ref and listing known ids from the session registry. *Expected RED:* fails today with the registry-unavailable error instead.
- [x] 2b.4 No session started and no registry at all: fails with the actionable "registry unavailable" error, and no agent session is created. *Expected:* passes today. Regression guard.
- [x] 2b.5 GREEN: let `resolveModel` take the session registry. Thread it from `index.ts` (session_start) through FlowManager and `runFlow` to `spawnAgent`/`resolveModel`, keeping `pi.modelRegistry` only as the last resort. Verify that group 2b is green and the existing `model-resolution.test.ts` stays green.

## 3. RED: runtime accessor helper (design decision 1)

Create `__tests__/model-runtime-accessor.test.ts`.

- [x] 3.1 A real `new ModelRegistry(runtime)` returns that exact `runtime`. *Expected RED:* the helper doesn't exist yet. **This is the canary.** It fails in CI if pi renames the private field.
- [x] 3.2 `undefined`, `{}`, a registry whose `runtime` lacks `prepareRequest`/`getModel`, and a getter that throws all return `undefined`, without throwing. *Expected RED.*
- [x] 3.3 When the helper returns `undefined` at `session_start` (simulated pi rename), flows still run on the default runtime: a disk-backed model (faux on default runtime) works, and the session doesn't crash. *Expected RED.*

## 4. RED: `max` thinking level (spec: flow-model-resolution)

Add to `__tests__/model-resolution.test.ts`.

- [x] 4.1 No handler; `anthropic/claude-opus-4:max` calls `find("anthropic","claude-opus-4")` and returns thinking `max`. *Expected RED:* `find` is called with id `claude-opus-4:max`.
- [x] 4.2 A bare id `claude-opus-4:max` is resolved as `claude-opus-4` with thinking `max`. *Expected RED.*
- [x] 4.3 Parameterised over every level (`off minimal low medium high xhigh max`): suffix is stripped and returned. Existing levels stay green, `max` is RED.
- [x] 4.4 An unknown suffix (`model:ultra`) is NOT stripped, so the id remains `model:ultra` and fails with the unknown-model error. *Expected:* passes. Regression guard.
- [x] 4.5 Frontmatter `thinking: max` on a faux agent means the spy shows `thinkingLevel: "max"` passed to `createAgentSession`, and it overrides a `:high` suffix. *Expected:* may pass already. Record it.
- [x] 4.6 Agent parser accepts `thinking: max` without a validation error (`agent-parser.test.ts`). Record RED or GREEN.

**Checkpoint:** commit the RED tests (`test: failing tests for flow runtime inheritance + max level`). In the commit body, list every test and its observed failure message.

## 5. GREEN: implementation (minimal, one test group at a time)

- [x] 5.1 Add `getModelRuntime(registry)` helper (reads the private `runtime`, validates its shape, catches errors, else `undefined`). Verify that 3.1 and 3.2 are green.
- [x] 5.2 In `index.ts`, store `sessionModelRuntime = getModelRuntime(ctx.modelRegistry)` at `session_start`, reassigning on every start. Remove `sessionAuthStorage`. Replace `getAuthStorage` with `getModelRuntime` in the FlowManager config. Verify that 2.10 and 3.3 are green.
- [x] 5.3 In `flow-manager.ts`, pass `modelRuntime` to `runFlow`. Drop `authStorage`. Verify that 2.1, 2.2, 2.3 and 2.7 are green.
- [x] 5.4 In `flow-execution.ts`, keep `modelRuntime` at all three pass-through sites. Remove `authStorage`, and remove `modelRegistry` where nothing reads it. Verify that all 2.4 cases are green and 2.5 stays green.
- [x] 5.5 In `execution.ts`, remove the dead `authStorage` option/type. Verify with `npm run typecheck`, and that 2.5 and 2.8 stay green.
- [x] 5.6 For `flow:get-spawn-context`, set `modelRuntime` and drop `authStorage`. Verify that 2.9 is green.
- [x] 5.7 Add `"max"` to `ThinkingLevelString` and `VALID_THINKING_LEVELS`, plus anywhere the agent parser validates levels. Update the comment in `types.ts`. Verify that group 4 is all green.
- [x] 5.8 Update `testing.ts` stubs to remove `authStorage`. Verify that the existing faux suites (`faux-*.test.ts`, `pi-runtime-alignment.test.ts`) are all green.
- [x] 5.9 Confirm 2.6 (model never inherited) is still green. If it fails, the implementation leaked model inheritance, so revert and fix.

## 6. Refactor (tests stay green)

- [x] 6.1 Remove orphans left by the change (unused imports, the `getAuthStorage` type, dead comments about `authStorage`), and update the misleading comment at `execution.ts` (the `modelRuntime` option block). Verify with `npm run lint` (no new warnings) and a green suite.
- [x] 6.2 (Skipped: the diff is small and already minimal.) Run `code-simplification` on the diff if it feels heavy. Verify the suite is unchanged and green.

## 7. Docs (delegated to a subagent for `docs/`)

- [x] 7.1 Add `max` to the level lists in `docs/flow-authoring.md` and `docs/agents.md`. Verify with `grep -n xhigh docs/*.md` (every hit also lists `max`).
- [x] 7.2 Add `max` in `.pi/skills/manage-flows/SKILL.md`. Verify with grep.
- [x] 7.3 Add a note to `docs/architecture.md`: flow agents share the parent session's model runtime (providers + keys, never the model), there's a fallback to the default runtime when no session exists, and the private-field caveat. Verify that the section exists.
- [x] 7.4 Update `docs/testing.md`: explain that faux harness tests pass `modelRuntime` explicitly and so cannot catch wiring bugs, and point to the `makeParentSession` fixture. Verify that the section exists.
- [x] 7.5 Add a CHANGELOG entry (fix: runtime-registered providers in flow agents on pi ≥0.80.8; feat: `max` thinking level; change: `flow:get-spawn-context` adds `modelRuntime`, drops `authStorage`). Verify that the entry exists.

## 8. Verification

- [ ] 8.1 Run `npm run lint && npm run typecheck && npm test`. All must be green, on Node 22 and 24, in CI.
- [x] 8.2 **Mutation check:** temporarily revert 5.3 (do not pass `modelRuntime`). 2.1, 2.2, 2.3, 2.4 and 2.7 must go RED. Restore. Then temporarily make the helper return `undefined`: 3.1 must go RED. Restore. Record both results in the PR.
- [ ] 8.3 **Manual TUI check:** run a flow whose agent uses a provider registered via `pi.registerProvider` (dashboard `proxy/...`, and separately a tiny local extension provider with no dashboard). It must fail on the base commit and succeed with the change. Record the results in the PR.
- [x] 8.4 Run `openspec validate flow-agents-inherit-model-runtime --strict`. It must pass.
