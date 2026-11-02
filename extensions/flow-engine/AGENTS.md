# DOX — extensions/flow-engine

Files in this area. Purposes left for the agent to author.

| `abort-utils.ts` | `signalRejection`, `raceWithAbort`: reject pending work with `FlowCancelledError` when `AbortSignal` fires. |
| `agent-parser.ts` | `parseAgentFile`/`parseAgentString`: frontmatter, access rules, outputs, body → `AgentConfig`; `model:` is a ref, list or omitted (`modelRefs`). |
| `discovery.ts` | `discoverAll`: merge built-in, package, user and project agent/flow dirs (project wins); `classifySource` labels project|user|package|built-in. Returns configs + warnings. |
| `edit-flow-config.ts` | Resolve/persist `flows.editFlow` in `.pi/settings.json`: `readEditFlowFlag`, `isEditFlowEnabled`, `setEditFlowFlag`, `parseEditModeArg`. |
| `edit-flow-reconcile.ts` | `makeEditFlowToolReconciler`: change-gated `flow_agents`/`flow_write` activation; `applyManageFlowsVisibility`: per-turn `manage-flows` prompt visibility. |
| `execute-code-step.ts` | `executeCodeStep`: run `CodeStep`/`CodeDecisionStep` handlers; typed inputs, timeout/abort, output validation, failure classification. |
| `execution.ts` | `spawnAgent`: isolated agent session; resolves models (`resolvedModel` used directly, else `resolveAgentModel`), context, skills, guards, finish latch, typed outputs, retries. |
| `failure.ts` | `classifyAgentOutcome`/`classifyThrownError`; `resolveRouteOutcome` applies `on_error` routing. |
| `finish-latch.ts` | `FinishLatch`: pair finish tool start/end by tool-call id; latch first successful finish params once. |
| `flow-execution.ts` | `runFlow`: schedules DAG segments, forks, loops, code nodes; pre-resolves models, `pickDecisionAgent`; `runDecision` routes via the decider chain (no first-branch fallback). |
| `flow-generate.ts` | `generateCodeHandlers`: write `.ts.default` code-node scaffolds; report `Input`/`Output` drift `Diagnostic`s. |
| `flow-io-tui.ts` | `TuiFlowIOAdapter` prompt queues/overlays/auto decisions; `HeadlessFlowIOAdapter` deterministic fallback responses. |
| `flow-io.ts` | `FlowIOAdapter`, `FlowObserver` (incl. `onDecision`), `AskUserExtra`, `AskUserResult` contracts for prompts, notifications and lifecycle events. |
| `flow-manager.ts` | `FlowManager`: one active run; mints `runId`, wires adapter/observers to `runFlow`, snapshots session model, flows settings, `projectTrusted`; forwards `onDecision`. |
| `flow-parser-yaml.ts` | `parseFlowYamlFile`/`parseFlowYamlString`: validate inputs and step shapes; `decision_agent`, `decider`, `state`, `{ to, means }` branches. |
| `flow-persist.ts` | `FlowEventPersister`: persist `flow:*` events as session entries (`flow:decision` → `flow_decision`); find orphaned runs; project run/node state. |
| `flow-prompt.ts` | `emitPromptAndAwait`: emit `flow:prompt-request`; first `flow:prompt-response` or PromptBus result wins; cancel on timeout. |
| `flow-tui.ts` | `setupFlowTui`, `TuiFlowObserver`, `EventEmitObserver`: render lifecycle, emit/persist `flow:*` events (`agent-started` has `modelFallback`; `flow:decision`). |
| `flows-settings.ts` | `readFlowsSettings`: `flows.modelFallback` (default `session`), `flows.decisionAgent`, `flows.decider`; project over global. |
| `guard.ts` | `createGuardExtension`: enforce allowed tools, `ask_user`, read/write/bash access, `finish` schema, declared outputs, post-finish lockout. |
| `index.ts` | Activate engine: discovery (re-run at each flow start), flow commands, tools, skills, gates, `flow:*` handlers; tracks `sessionModel`, `isProjectTrusted`; dispatches via `FlowManager`; `userFlowsRoot`. |
| `model-roles.ts` | `resolveModel`: `@role`/literal/thinking suffix via `model:resolve`, then registry; `resolveAgentModel`: ordered refs → session-model fallback; errors keep resolver detail. |
| `prompt-bus-access.ts` | Cache PromptBus request fn from `prompt:set-bus-request`: `setPromptBusRequest`, `hasPromptBus`, `promptBusRequest`, `listenForPromptBus`. |
| `result-parser.ts` | `parseResult`: agent `<result>` XML → `ParsedResult`; `hasArtifactElement` detects nested artifact tags by dotted path. |
| `testing.ts` | Faux harness: `scriptFinish`/`scriptError`, `registerFauxOnRuntime`, `spawnFaux`, `runFaux`, `runFauxFlow`; options: parent model, fallback, decider, `entryOverrides`, `onDecision`. |
| `types.ts` | Flow-engine contracts: configs, steps, results, events, `FailureInfo`, `FlowHardError`, `modelRefs`, `ModelFallbackInfo`, `DeciderSpec`, `DecisionEvent`. |
