# DOX — extensions/flow-engine

Files in this area. Purposes left for the agent to author.

| `abort-utils.ts` | Expose `signalRejection` and `raceWithAbort`; reject pending work with `FlowCancelledError` when `AbortSignal` fires. |
| `agent-parser.ts` | Parse agent Markdown via `parseAgentFile`/`parseAgentString`; map YAML frontmatter, access rules, outputs, and prompt body into `AgentConfig`. |
| `anthropic-messages-adapter.ts` | Export `anthropicMessagesAgentFactory`; resolve optional `@blackbelt-technology/pi-anthropic-messages` bridge and apply transforms to spawned sessions. |
| `discovery.ts` | Discover bundled, project, and extra agent/flow directories via `discoverAll`; parse `.md` agents and `flow.yaml`; return configs plus warnings. |
| `edit-flow-config.ts` | Resolve and persist `flows.editFlow` in `.pi/settings.json`; expose `readEditFlowFlag`, `isEditFlowEnabled`, `setEditFlowFlag`, `parseEditModeArg`. |
| `edit-flow-reconcile.ts` | Build `makeEditFlowToolReconciler`; add or remove `flow_agents` and `flow_write` from active tools only when edit-mode changes. |
| `edit-flow-skill.ts` | Materialize project `.pi/skills/manage-flows/SKILL.md`; sync `disable-model-invocation` through `syncEditFlowSkill` without writing package templates. |
| `execute-code-step.ts` | Execute `CodeStep`/`CodeDecisionStep` handlers via `executeCodeStep`; resolve typed inputs, timeout/abort work, validate outputs, classify failures. |
| `execution.ts` | Plan and spawn isolated agent sessions via `spawnAgent`; resolve models, context, skills, guards, finish latch, tools, templates, typed outputs, retries. |
| `failure.ts` | Classify agent and thrown failures with `classifyAgentOutcome`/`classifyThrownError`; apply `on_error` routing through `resolveRouteOutcome`. |
| `finish-latch.ts` | Create `FinishLatch`; pair finish tool start/end events by tool-call id and latch first successful finish parameters exactly once. |
| `flow-execution.ts` | Run flow DAGs via `runFlow`; schedule segments, agents, forks, decisions, loops, and code nodes; route branches/failures; validate inputs; handle aborts. |
| `flow-generate.ts` | Generate `.ts.default` code-node scaffolds with `generateCodeHandlers`; compare real `Input`/`Output` interfaces and return drift `Diagnostic`s. |
| `flow-io-tui.ts` | Implement `TuiFlowIOAdapter` prompt queues, overlays, notes, custom and auto decisions; implement `HeadlessFlowIOAdapter` deterministic fallback responses. |
| `flow-io.ts` | Define `FlowIOAdapter`, `FlowObserver`, `AskUserExtra`, and `AskUserResult` contracts for prompts, extension UI, notifications, and lifecycle events. |
| `flow-manager.ts` | Coordinate one active run in `FlowManager`; mint `runId`, wire `FlowIOAdapter` and `FlowObserver`s to `runFlow`, dispatch events, abort, and clean up. |
| `flow-parser-yaml.ts` | Parse files or strings with `parseFlowYamlFile`/`parseFlowYamlString`; validate flow inputs and agent, fork, decision, loop, and code step shapes. |
| `flow-persist.ts` | Persist `flow:*` events as `flow-event` session entries via `FlowEventPersister`; map event names, find orphaned runs, and project run/node state. |
| `flow-prompt.ts` | Emit `flow:prompt-request` through `emitPromptAndAwait`; accept first matching `flow:prompt-response` or PromptBus result; cancel on timeout. |
| `flow-tui.ts` | Wire flow dashboard and summary TUI via `setupFlowTui`; observe/render lifecycle, emit and persist `flow:*` events, handle navigation and orphaned runs. |
| `guard.ts` | Build `createGuardExtension`; enforce allowed tools, `ask_user`, read/write/bash access, prefixed `finish` schema, declared outputs, and post-finish lockout. |
| `index.ts` | Activate flow engine; discover/register flows, agents, tools, skills, gates, commands, and `flow:*` event handlers; dispatch runs through `FlowManager`. |
| `model-roles.ts` | Resolve `@role`, `provider/model-id`, and thinking suffixes via `resolveModel`; use `model:resolve` first, then `pi.modelRegistry` literal fallback. |
| `prompt-bus-access.ts` | Cache PromptBus request function from `prompt:set-bus-request`; expose `setPromptBusRequest`, `hasPromptBus`, `promptBusRequest`, `listenForPromptBus`. |
| `result-parser.ts` | Parse agent `<result>` XML into `ParsedResult` via `parseResult`; detect nested artifact tags by dotted path through `hasArtifactElement`. |
| `testing.ts` | Expose zero-network faux harness: script finish/tool/error responses, register faux `ModelRuntime`, run `spawnFaux`, `runFaux`, and `runFauxFlow`. |
| `tool-prefix.ts` | Define `CORE_TOOL_NAMES`; apply `mcp__flows__` to non-core, non-MCP tool names through `prefixToolName` for Anthropic OAuth. |
| `types.ts` | Define flow-engine contracts: configs, steps, results, events, typed I/O, code handlers, diagnostics, `FailureOutcome`, `FailureInfo`, and `FlowHardError`. |
