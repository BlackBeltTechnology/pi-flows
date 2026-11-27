# Proposal

## Why

Fork steps and agent extension prompts (`ctx.ui.select/confirm/input` inside a flow agent) reach the **human** through a TUI/dashboard dialog (`createSubagentUIContext` → `onExtensionUIRequest` → `TuiFlowIOAdapter` / `AskUserQueue`). Flow agents themselves have no way to ask anyone. The main session's model — which started the flow and holds the conversation context — never sees these questions, and it cannot wait for a flow except by polling `flow_results` or project shims (`.pi/extensions/batch-apply.ts`). A flow should behave like a background subagent of the main session: questions go to the parent model, the parent answers (escalating to the human with its own `ask_user` only when it must), and the parent can wait for the flow. `pi-dashboard-subagents` proves this pattern (`ask_parent` + `AgentControl` mailbox / push / wait / reply).

## What Changes

- **Parent-attached runs.** A run is *parent-attached* when started by the new `flow_run` tool, by `flow:run` with `notifyParent: true`, or by a slash command in a session with a UI (`ctx.hasUI`: TUI or RPC/dashboard). Other runs (print/JSON-mode slash commands, host automations, programmatic `runFlow`) keep the headless behaviour.
- **Mailbox.** One per flow manager: open questions and run outcomes. Several questions MAY be open at once (parallel steps, fan-out instances, extension prompts); each asker parks independently. Question ids are random and unique within the process.
- **`ask_parent` tool** injected into every worker agent of a parent-attached run (not decision/decider agents), regardless of its `tools:` list. It parks until answered. Optional `timeout_s` + `default`: on timeout the asker gets the `default` string (a steering text); a built-in text otherwise. No timeout by default. Autonomous mode does not disable it.
- **Forks ask the parent** in parent-attached runs, regardless of the global autonomous toggle (which now only affects detached runs), instead of a dialog. The parent answers with option(s), or — when the fork has a decider — `decide` / free text to delegate to it; an exhausted delegation is re-asked once with options only. Optional fork fields `ask_timeout_s` / `ask_default`. Delegating never flips the global autonomous flag.
- **Agent extension prompts** (`ctx.ui.select/confirm/input`) in a parent-attached run become parent questions instead of human dialogs.
- **Push.** New questions and the run end are batched (1 s) into one visible `flow:mail` message delivered as `followUp` + `triggerTurn`; nothing is pushed while the parent is blocked in `wait`. Lifecycle markers are deferred while a parent turn is in progress, so a push-started turn can never get a marker spliced into its `tool_use`.
- **Main-session tools:** `flow_run {flow, task?, inputs?}` → `runId` or the decline reason; `flow_control {action: wait | reply | status | cancel}`, acting only on parent-attached runs. Typed inputs are now checked before a dispatched run starts (as `typed-flow-input` already requires).
- `.pi/extensions/batch-apply.ts` passes `notifyParent: true`.
- **Events (mandatory, persisted, run-scoped):** `flow:question`, `flow:answer`.
- **Removed:** the human dialog adapter (`TuiFlowIOAdapter`, `AskUserQueue`, fork select/notes/checkbox dialogs). **BREAKING:** in attached runs the parent model answers (and asks the human via its own `ask_user` when it needs to); detached runs in UI sessions no longer prompt a human — forks take the decider / first option and extension prompts resolve cancelled.
- **Fixed on the way:** multi-select fork answers are no longer joined into one string by the flow manager.

Non-goals: concurrent flow runs in one process (one-run rule stays); cross-session/bus transport; freeing a parked agent's place in its wave; the in-flight `batch-apply-example` change (follow-up).

## Capabilities

### New Capabilities
- `flow-parent-questions`: how flow agents, agent extension prompts and fork steps ask the parent — attachment, `ask_parent`, parking, parallel questions, timeout/default, answer validation, closing on stop, headless fallback.
- `flow-session-control`: how the parent drives flows — `flow_run`, `flow_control` (wait / reply / status / cancel), the `flow:mail` push, and the `flow:question` / `flow:answer` events.

### Modified Capabilities
- `subagent-spawn`: the guard always allows the injected `ask_parent` of worker agents; one `ask_parent` definition per agent session.
- `flow-run-dispatch`: `flow_run` calls the `flow:run` code path directly, which reports its outcome (runId or decline reason); typed inputs are a pre-start check; `flow:run` accepts `notifyParent`.
- `flow-session-persistence`: question events are persisted; lifecycle markers are deferred while a parent turn is in progress.
- `dashboard-event-emission`: the run-scoped event set grows from eleven to thirteen channels.
- `decision-routing`: a fork's label is supplied by the parent session (or its decider), not a human.

## Discipline Skills

`doubt-driven-review` (public tool/adapter removal, cross-boundary push into the parent session), `observability-instrumentation` (new persisted events, push path).

## Impact

- Code: `extensions/flow-engine/` — new mailbox (routed by `FlowManager`) + `tools/ask-parent.ts`, `tools/flow-run.ts`, `tools/flow-control.ts`; `flow-io.ts` (`onQuestion`/`onAnswer` observer hooks, ask extras — additive public API), `flow-io-tui.ts` (dialog code removed), `flow-manager.ts` (mailbox, start returns runId, attachment, array answers, signal combine, closing before completion), `flow-execution.ts` (`FlowRunOptions.parent`, fork ask path + re-ask + on_error, answer type, per-spawn `ask_parent` + UI meta, halt signal to asks), `execution.ts` (spawn options, dedupe, UI bridge meta/signal/timeout), `testing.ts` (answer type), `guard.ts` (always-allowed tools), `tools/agent-validate.ts` (`ask_parent` known), `flow-parser-yaml.ts` + `tools/flow-validate.ts` (fork `ask_timeout_s`/`ask_default`), `flow-persist.ts` (event map, marker guard), `flow-tui.ts` (`EventEmitObserver` emits/persists question events, orphan reconciliation), `index.ts` (adapter + attachment, `runFlowByName` outcome, `flow:run` field, tool registration).
- Tests: fork tests asserting the dialog adapter / `__auto_decide__` via the TUI path are rewritten against the mailbox.
- Docs: `docs/tools-reference.md`, `docs/events-api.md`, `docs/flows.md`, `docs/architecture.md`, `docs/public-api.md`, `CHANGELOG.md`.
- Dashboard (`pi-agent-dashboard` flows-plugin, follow-up): map `flow_question` / `flow_answer` to a "waiting on parent" card.
