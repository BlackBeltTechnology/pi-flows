# Tasks

Spec tests (written first, failing): `__tests__/flow-parent-mailbox.test.ts`. "Verify" = the named describe block passes plus `npm run typecheck`.

## 1. Dispatch outcome and attachment

- [ ] 1.1 `FlowManager.start` returns `{runId}` and records `attached`; `runFlowByName` returns `{runId} | {rejected}` and accepts `notifyParent`; slash command passes `attached = hasUI`; verify existing `flow-dispatch` / `flow-run-rejection-and-identity` tests still pass
- [ ] 1.2 Move the typed-input check into `runFlowByName`'s pre-start checks (rejection `flow:complete`, no `flow:flow-started`); verify "flow:run typed inputs are a pre-start check" passes and existing typed-input tests still pass
- [ ] 1.3 `.pi/extensions/batch-apply.ts` emits `flow:run` with `notifyParent: true`; verify by reading the emit call

## 2. Mailbox and events

- [ ] 2.1 `FlowMailbox` (questions with random ids, record fields, validation of answers incl. multi-select/fork rules, timers + defaults, `closeRun`, pushed/waitSeen flags, single waiter) in `extensions/flow-engine/flow-mailbox.ts`; verify via the e2e blocks in 3–5
- [ ] 2.2 `FlowObserver.onQuestion` / `onAnswer`; `EventEmitObserver` emits `flow:question` / `flow:answer` with `runId` and persists them; `FLOW_EVENT_NAME_MAP` += `flow_question` / `flow_answer`; questions closed before `onFlowComplete`; verify "persistence › question events are persisted…" passes
- [ ] 2.3 `OrphanedRun` carries open question ids; `reconcileOrphanedRun` persists `flow:answer {via: cancel}` before the terminal record; verify "orphan reconciliation…" passes
- [ ] 2.4 Push: 1 s batch built at flush, empty → nothing, `sendMessage({customType: "flow:mail", display: true}, {deliverAs: "followUp", triggerTurn: true})`, attached only, suppressed while waiting, run end included; verify "a run end is pushed for attached runs only" and the push assertions in the round-trip test pass

## 3. ask_parent

- [ ] 3.1 `FlowRunOptions.parent` handle set by `FlowManager` for attached runs; `SpawnOptions.askParent` built in `flow-execution.ts` for worker agent steps and fan-out instances; `spawnAgent` dedupes by name, appends, guard `alwaysAllowedTools`; verify "ask_parent" describe passes
- [ ] 3.2 `tools/ask-parent.ts`: argument validation, timeout/default, signal race; `agent-validate` knows `ask_parent`; verify "invalid arguments…", "timeout…", "validation › ask_parent is a known agent tool" pass
- [ ] 3.3 Parallel and fan-out questions; verify "parallel questions" describe passes
- [ ] 3.4 Decision agents/deciders get no `ask_parent`; detached runs get none; verify "who can ask › an agent-decision agent…" and "detached flow:run…" pass

## 4. Extension prompts and forks

- [ ] 4.1 `SpawnOptions.uiMeta`; `createSubagentUIContext` sends step/item meta and honours `opts.signal`/`opts.timeout`; `FlowManager` routes attached worker prompts to the mailbox, else cancelled; verify "an extension tool's ctx.ui.confirm…" passes
- [ ] 4.2 `FlowRunOptions.askUser` answer `string | string[]`; `FlowManager` stops joining and combines signals; fork asks through `options.parent` when attached (ignoring autonomous), records joined text; verify "fork steps ask the parent" (pick, multi-select, closed, detached) pass and existing fork tests still pass
- [ ] 4.3 Delegation (`decide`, free text → sentinels, only with a decider), exhausted → `on_error` or one re-ask without delegation; verify delegation / exhausted tests pass
- [ ] 4.4 `ask_timeout_s` / `ask_default` parsed + validated in `parseForkStep` and `tools/flow-validate.ts`; timeout takes the default; verify "validation" describe and "a fork with ask_timeout_s…" pass
- [ ] 4.5 Delete `TuiFlowIOAdapter` / `AskUserQueue` / dialogs; `HeadlessFlowIOAdapter` gains optional `ui` for `notify`; `session_start` no longer swaps adapters; rewrite existing tests that used the TUI adapter; verify `npm test` has no reference failures

## 5. Main-session tools

- [ ] 5.1 `tools/flow-run.ts` (`flow_run`: `task_required` argument check, `runFlowByName(..., notifyParent: true)`, returns runId / decline reason); verify "flow_run" describe passes
- [ ] 5.2 `tools/flow-control.ts` (`wait` / `reply` / `status` / `cancel`, attached-only scope, wait signal race, status via the run-state projection); verify "flow_control wait" and "cancel and scope" describes pass

## 6. Markers

- [ ] 6.1 `FlowEventPersister` defers start/completion markers while the session is not idle and appends them on `agent_end`; verify "lifecycle markers wait for the parent's turn to end" and existing `flow-persist*` tests pass

## 7. Docs and integration

- [ ] 7.1 Docs via a general-purpose subagent: `docs/tools-reference.md` (`ask_parent`, `flow_run`, `flow_control`; `ask_user` main-session only), `docs/events-api.md` (`flow:question`, `flow:answer`, `flow:mail`, `notifyParent`), `docs/flows.md` (fork asking, `ask_timeout_s`/`ask_default`, autonomous semantics), `docs/architecture.md`, `docs/public-api.md`; CHANGELOG (BREAKING); directory `AGENTS.md` rows; verify `grep -n ask_parent docs/*.md` hits each file
- [ ] 7.2 Full gate: `npm run lint && npm run typecheck && npm test` green

## Workflow follow-up

- Dashboard (`pi-agent-dashboard` flows-plugin): map `flow_question` / `flow_answer`.
- `batch-apply-example`: rewrite "Agent questions reach the operator" to the parent mailbox.
- Archive after review.
