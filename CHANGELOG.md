# Changelog

All notable changes to pi-flows will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.3.5] - 2026-08-07

### Added

- **`flow:run` declines are observable, and every run carries an identity** (`flow-run-dispatch` + `dashboard-event-emission` + `flow-session-persistence` capabilities). A `flow:run` that does **not** start a flow (unknown flow / already-running / gate-blocked / a lost check-to-assign race) now emits a **terminal `flow:complete`** carrying `status: "rejected"`, a top-level `reason` (byte-identical to the slash-command messages, produced by a shared builder so parity holds by construction), `flowName`, and the same reason mirrored into `lastResult.result.summary`. This is renderable by a consumer that never saw `flow_started`, and it finalizes an event-dispatched automation run in seconds (via the existing `flow_complete` completion) instead of leaving it wedged until a stale-run reaper fires. `results` is omitted (so no spurious post-flow summary is written for a run that never started); a rejection carries no `runId`. Previously every decline returned silently.

  The single-run guard is now **atomic**. The duplicate `isRunning` guard on the `flow:run` handler is removed; `FlowManager.start()` marks the run active **before its first `await`** (a synchronous-prologue IIFE closes the check-to-assign window); and the now-reachable "already running" throw is surfaced as the same terminal rejection rather than an unhandled promise rejection — so two dispatches racing into one long-lived session can no longer start two concurrent runs in one process.

  Every run now carries an **identity on the live event stream**. `FlowManager.start()` mints the run id (exposed as `activeRunId`) and threads it to `onFlowStarted`; `EventEmitObserver` stamps it on every core lifecycle `flow:*` payload and onto `FlowResult.runId` — present in headless/RPC sessions, not only under a TUI. `FlowEventPersister` now records the **supplied** id instead of self-minting on `flow:flow-started`, so the persisted `flowRunId` equals the id on the live payloads; the orphan-reconciliation `persistTerminal(orphanId, …)` injection is preserved. `FlowResult` gains `runId?` and `reason?`, and its `status` union gains `"rejected"`; `FlowObserver.onFlowStarted` gains `runId` as its first parameter. OpenSpec: report-flow-run-rejection-and-run-identity.

## [v0.3.4] - 2026-07-15

### Added

- **`flows.editFlow` applies to a running session per turn** (`edit-mode` + `flow-authoring` capabilities). The setting is now re-read and the `flow_agents`/`flow_write` authoring tools reconciled at the start of each agent turn (`before_agent_start`), so an out-of-band change — e.g. hand-editing `.pi/settings.json` while a session is running — flips the tools on the session's **next agent turn without a restart**. The re-check is change-gated (a small extracted `makeEditFlowToolReconciler` in `extensions/flow-engine/edit-flow-reconcile.ts`), so unchanged turns do not rebuild the system prompt. Scope is **tools only**: the `manage-flows` skill's prompt-visibility still applies on the next session start / reload, because turn/event hooks receive the base `ExtensionContext`, which has no `reload()` (the skill stays reachable throughout via `/skill:manage-flows`). **The project-trust gate on `flows.editFlow` is removed** — the project `.pi/settings.json` value is now honored regardless of project trust (still overriding global; global still always honored). OpenSpec: apply-editflow-setting-live.

## [v0.3.2] - 2026-07-01

### Removed

- **BREAKING: the `on_complete` step field was removed** (`node-failure-model` + `decision-routing` + `flow-wiring` + `code-node` capabilities). `on_complete` was an unconditional forward-jump routing edge that duplicated `blockedBy` (ordering) and `fork`/`*-decision` (path selection), and — unlike decision branches — was covered by neither cycle guard (the validator's cycle check walks only `blockedBy`; the `max_iterations` backward-edge rule walks only decision `branches`). Combined with implicit fall-through it could form unbounded cross-segment loops. Now: a node that succeeds **falls through to the next step in file order** (no success routing); `on_error` (soft-failure routing) and decision `branches` are unchanged. Declaring `on_complete` is a validation **error** with an actionable migration message. Migrate by (1) deleting `on_complete: X` when X is simply the next step (fall-through is identical), (2) using a `fork`/`code-decision` to select a forward path when it skipped steps, and (3) adding `blockedBy: [X]` where a `${{result.X}}` reference relied on the `on_complete` chain for ordering. The `${{result.X}}` ordering-validity rule now accepts `blockedBy` ancestry, an `on_error` chain, or a decision/loop branch chain. No bundled flow YAMLs used `on_complete`. OpenSpec: remove-on-complete-routing.

### Added

- **Flow completion carries outcome metadata** (`flow-completion-signal` capability). The end-of-flow persistence message now embeds the flow's terminal `status` (`success` | `error` | `aborted`) and result summary — `[flow] <name> <status>: <summary>` — so a host/automation runner can display success/failure, not just that the run ended. `runFlow` now sets `FlowResult.status` to `"success"` on completion (and `"aborted"` on cancellation); the happy path previously left it undefined. This single completion message also opens pi's `hasAssistant` flush gate (persisting the buffered flow-event stream for `/resume`), so there is no separate marker.

  Supersedes the earlier unshipped `auto_end` + `ctx.shutdown()` design: **the `auto_end` flow key, the mode gate, and the `ctx.shutdown()` call are removed.** `ctx.shutdown()` is a no-op in headless/RPC mode (and the dashboard's RPC keeper holds the process open regardless), so pi-flows does not shut down sessions. Ending a dashboard automation run is the automation layer's responsibility, triggered off the run's `agent_end` — surfacing that for event-launched flow runs is dashboard-side work (a pi extension cannot emit the core `agent_end` event).

## [v0.3.1] - 2026-06-29

### Added

- **Public flow-testing API via the `@blackbelt-technology/pi-flows/testing` subpath export** (`faux-model-testing` + `package-manifest` capabilities). The faux-model harness — previously internal test scaffolding confined to `__tests__/` — is now a shipped, consumable module at `extensions/flow-engine/testing.ts`. Downstream flow packages can test their own flows in-repo against the **real** `runFlow` / `spawnAgent` engine with a scripted, zero-network faux provider: `import { runFauxFlow, spawnFaux, runFaux, scriptFinish, scriptToolThenFinish, scriptError, scriptSlowText, makeAgent, lastUserText, parseFlowYamlString } from "@blackbelt-technology/pi-flows/testing"`. The engine entrypoints `runFlow` / `spawnAgent` are intentionally NOT exported (the faux runners wrap them), so the committed public surface is the scripted-faux-testing semantics rather than internal engine signatures. The nested-`pi-ai` provider registration now anchors to pi-coding-agent's real install location (following the dependency edge) so it resolves correctly when pi-flows is an installed dependency under both npm (deduped + version-pinned-nested) and pnpm (symlink) layouts — not only the dev clone. The in-repo `__tests__/faux-harness.ts` is now a thin re-export of the shipped module, so the surface the suites exercise is identical to the published one. See [docs/testing.md](docs/testing.md). The consumer must run tests under a TypeScript-aware loader (e.g. vitest), same `.ts`-entry constraint as the root export.

## [v0.3.0] - 2026-06-29

### Changed

- **The flow/agent authoring skill was renamed `edit-flow` → `manage-flows`.** It always created *and* edited flows/agents, but the `edit-flow` label read as modify-only and confused users at invocation. The command is now `/skill:manage-flows`; the packaged skill lives at `skills/manage-flows/SKILL.md` and the project-local copy at `.pi/skills/manage-flows/SKILL.md`. The `flows.editFlow` setting and the `/flows:edit-mode` command are unchanged. (Unreleased rename — no migration; the previous name never shipped.)

### Removed

- **BREAKING: the result `artifacts` and `files` fields were removed** (`structured-step-data` capability) — from the step result contract, the `finish` tool schema, and the template surface. `${{result.X.artifacts}}` / `${{result.X.files}}` no longer resolve. The typed value channel between steps is **`outputs` only**. The `file://` input-injection mechanism was also removed: file-backed data is now passed as a **path** value and read at runtime (an agent via its `read` tool, a code node via the filesystem).
- **BREAKING: the `flow-ref` step type was removed.** Flows can no longer delegate to a sub-flow via `type: flow-ref`. The runtime path was fragile (paths resolved against the process CWD rather than the parent flow's directory, and any failure — missing file, parse error, sub-flow throw — was silently swallowed, producing no result and no diagnostic) and sub-flow nodes were never registered in the dashboard grid, so delegated work ran invisibly. Its only unique capability (glob fan-out over flow files) did not justify the maintenance and footgun cost; every other use overlapped existing primitives. A step declaring `type: flow-ref` is now rejected as an unknown step type. Migrate by inlining the sub-flow's steps into the parent flow, or invoke the flow directly.

### Changed

- **BREAKING: every flow step must declare an explicit `type:`** (`decision-routing` capability) — the YAML parser no longer infers a step's type from which fields are present. A step missing `type:` is rejected with an error naming the step id and listing the valid types (`agent`, `agent-decision`, `code`, `code-decision`, `fork`). This removes the silent-reclassification footgun (a typo'd discriminator or stray `branches:` no longer changes a step's type) and collapses the rule to one line: every step declares its `type:`. Flows authored before this change that relied on inference must add the `type:` line to each step.

### Added

- **Typed I/O between steps** (`structured-step-data` capability) — step `outputs` are stored as their real JSON types (string/number/boolean/object/array/null), never coerced to strings. A code-node input that is **exactly** a single `${{result.X.NAME}}` / `${{flow.input.NAME}}` reference is delivered to the handler **unchanged** (typed); an embedded reference (and any agent prompt/task interpolation) is just-in-time serialized to **compact JSON**. Code handlers may return any JSON type for their declared outputs (the prior object/array/null soft-failure rule is removed; the exact-declared-keys rule stands). Non-string declared **agent** outputs are validated by `finish` and stored with their declared type. The code-handler input type is `Record<string, unknown>`.
- **Typed flow inputs** (`typed-flow-input` capability) — a flow may declare an `inputs:` schema in its frontmatter (`NAME: { type: string|number|boolean|object|array, required?: true }`). A run started with a structured inputs object is validated against the schema (a missing `required` input or a type mismatch fails the run start); values are referenceable as `${{flow.input.NAME}}` with the same typed-delivery / JIT-serialization rules as result outputs. The single-`task` start path is unchanged.
- **`flow_results action:"runs"`** (`run-state-exposure` capability) — a read-only seam over the persisted flow-event stream: with no args it lists this session's runs (live/finished + per-node counts); with a `flow` name it details that flow's latest run as per-node state (`pending`/`running`/`finished` + result status/summary), merging produced `outputs` from the completed-run result JSON. Strictly read-only (cannot mutate a run). Authoring guard: a `*_path`/`*_file` input wired into an agent that lacks the `read` tool now emits a validation **warning**.
- **`code` step type** (`code-node` capability) — run deterministic TypeScript as a first-class DAG node, wired exactly like an agent. A code node's handler is the **default export** of a `.ts` module, invoked `(input, ctx)`: declared `inputs:` are delivered to the handler (a whole-value reference typed, an embedded reference JIT-serialized to compact JSON); the returned object must contain exactly the declared `outputs:` (any JSON-compatible type — stored typed, not stringified) and is merged into the result context as typed outputs. `ctx: CodeNodeContext` (exported from the package, alongside `CodeNodeHandler<I,O>`) carries `signal`, `cwd`, `logger`, `setSummary`, `flowName`, `stepId`, and `task`. Handlers run in-process (jiti dynamic import) with cooperative `AbortSignal`; an optional `timeout` is a soft deadline. Failure routing follows the node-failure-model: a plain `throw` (or a contract/coercion/missing-handler/timeout failure) is **soft**, `throw new FlowHardError(msg)` is **hard**.
- **Code-node handler generation** — on every successful `flow_write` (and via the new `/flows:generate <name>` command), pi-flows writes an inert `<id>.ts.default` reference template at `.pi/flows/handlers/<flow>/<id>.ts.default` with `Input`/`Output` interfaces derived from the node's `inputs`/`outputs` and a default-export stub. Copy it, drop `.default`, and implement the body. Templates are always regenerated and never touch the real `.ts`; nodes with a custom `target:` get no template. When a real handler exists, a non-fatal **drift warning** flags a mismatch between its `interface Input`/`Output` blocks and the YAML.
- **`code-decision` step type + unified routing** (`unify-decision-routing` capability) — a `code-decision` node runs a TypeScript handler exactly like a `code` node (same handler path, `inputs`/`outputs`, soft `timeout`, soft/hard failure model) and additionally routes on a reserved `branch` output resolved against a `branches:` map (`label → stepId`). `branch` is reserved (never a declared data output; declaring one named `branch` is a validation error); a missing `branch` is a **soft** failure, an off-map `branch` is a **hard** failure that halts the flow (consistent with `agent-decision`). A `*-decision` must declare ≥2 branches. `/flows:generate` emits a `type Branch = "…" | "…"` union and types the handler return as `Promise<{ branch: Branch } & Output>` so a wrong label is a compile-time error.
- **Loops are backward branch edges** — any `*-decision` (`agent-decision` or `code-decision`) branch whose target is an earlier step re-enters the node (a loop) and MUST declare `max_iterations`; the engine reuses the per-node loop counters and forces exit at the cap. `agent-decision` gains `max_iterations` (subsuming the removed `agent-loop-decision`). The dashboard ↻ iteration badge is driven by `flow:loop-iteration`, emitted only when a backward edge is actually taken (never inferred from the presence of `max_iterations`). `code-decision` lifecycle events are tagged `kind: "code-decision"`.
- **Unified node failure model** (`node-failure-model` capability) — every node now resolves to exactly one outcome: `success`, `soft`, or `hard`. `success` routes `on_complete`; a `soft` failure routes `on_error`; a `hard` failure aborts in-flight parallel steps, skips pending steps, and ends the flow with status `error` and the failure message surfaced in the flow result. Agent failures are classified **structurally** (no error-message parsing): `finish(complete)` → success, `finish(error|blocked)` → soft, no-finish **with** a terminal API error → hard, no-finish **without** an API error → soft. The no-finish nag is capped at 2 reminders, then a clean soft failure (no more `status:"unknown"`).
- **`FlowHardError`** — exported from the package entrypoint. Code/extension nodes signal an unconditional hard stop with `throw new FlowHardError(msg)`; a plain `throw` is soft. Also exports the `FailureOutcome` / `FailureInfo` types and the `classifyAgentOutcome` / `classifyThrownError` / `resolveRouteOutcome` helpers.
- pi-flows relies on pi-coding-agent's built-in transient-error retry and adds **no** redundant retry layer; an agent error reaching the engine is terminal.
- **Agent node contract enhancements** (`enhance-agent-node-contract`) — three additive agent frontmatter fields plus enforced outputs:
  - **`fork_session: true|false`** (default `false`) — opt-in to inherit the operator's main-session conversation data. When set, the spawned agent's session is forked from the operator's persisted session file via the SDK `SessionManager.forkFrom`; falls back to a fresh in-memory session when the main session is not persisted. Agent writes land in the fork, not the operator's live session.
  - **`context_files: [paths]`** — each path is read at spawn and injected into the agent's system prompt as a `## Context: <path>` preamble section. Missing/unreadable files are skipped (non-fatal). `AGENTS.md` is just one possible path.
  - **Output `type` / `pattern` constraints** — declared `outputs` entries accept optional `type: string|number|boolean` and `pattern: <regex>`. Values stay string-valued downstream; the constraints validate the string content (`number` → numeric string, `boolean` → `true`/`false`, `pattern` → regex match). Explicit `pattern` wins over `type`; an invalid regex degrades to an unconstrained required string.
  - First test coverage for agent parsing, finish-tool schema construction, output validation, context-file loading, and the fork/in-memory session decision.
- **Edit-mode toggle** (`add-edit-mode-toggle`) — a single switch couples the authoring tools and the `edit-flow` skill's prompt-visibility, applied live. New command **`/flows:edit-mode <on|off>`** and inbound dashboard event **`flow:set-edit-mode { enabled }`** converge on one handler that: writes `flows.editFlow` to the project `.pi/settings.json` (read-merge-write, never the global file); materializes/syncs a **project-local** skill copy at `.pi/skills/edit-flow/SKILL.md` (from the packaged template, never `node_modules`) with frontmatter `disable-model-invocation: !enabled`; reconciles `flow_agents`/`flow_write`; and triggers a live reload on the command path (`ctx.reload()`). On → AI sees the skill + has the tools; off → skill hidden from the prompt (still reachable via explicit `/skill:edit-flow`) + tools inactive. The project-local skill is also synced at every `session_start` (idempotent), so it is discoverable by default with frontmatter reflecting the current setting. The event path has no `reload()` (base `ExtensionContext`): tools update immediately, skill visibility applies next session.
- **Flow-wiring hardening** (`harden-flow-wiring`) — end-to-end test coverage for the template-expansion engine (all 10 variable forms, typed-output resolution for agent & code nodes, input wiring, edge cases) plus a finish-output retry contract test.
- **First-class node kind** (`surface-node-kind`) — a single `NodeKind` discriminator (`agent | fork | agent-decision | code | code-decision`, exported from the package) is now emitted by every node executor and carried end-to-end: through the `FlowManager` fan-out (which previously dropped it), on the `flow:agent-started` / `flow:agent-complete` payloads, and into the persisted `FlowEventRecord.data` — so live and replayed runs can pick a card renderer by node type, and a code node's `logger()` output is a program log by virtue of its card's kind. Code/code-decision started events also carry the resolved handler `target`. `FlowObserver.onAgentStarted`/`onAgentComplete` gain an optional `extra: { nodeKind?, target? }` argument (additive). No new `flow:*` event or `FLOW_EVENT_MAP` entry; the dashboard reducer reads `nodeKind` off `flow_agent_started` (cross-repo follow-up, lands independently, degrades to a generic card when absent).

### Changed

- **BREAKING (flow layout):** each flow is now a self-contained directory — `.pi/flows/flows/<namespace>/<name>/flow.yaml`, with its code-node handlers (`<id>.ts`, `<id>.ts.default`) **co-located in the same directory**. Handlers resolve relative to the flow's own directory (`dirname(flow.source)/<id>.ts`) in both the executor and the generator, so the scaffolded template path and the runtime path always match (fixes the prior drift where the generator wrote to `.pi/flows/flows/handlers/<frontmatter-name>/` while the runtime read `.pi/flows/handlers/<namespace>:<name>/`). Discovery derives the `/<namespace>:<name>` command from the directory structure; deleting a flow removes its whole directory (handlers can't be orphaned). The old flat `<name>.yaml` layout and the parallel `.pi/flows/handlers/` tree are **no longer read** (no fallback). Migrate: `mv <name>.yaml <name>/flow.yaml` and move that flow's handlers into the directory.
- **BREAKING (peer deps):** require `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai` `^0.80.0` (was `^0.74.0`, which excluded the 0.80 runtime). Dropped the dead pi-ai `getModel` fallback (removed in 0.80; registry resolution unchanged).
- **BREAKING (keybindings):** all flow keybindings moved to the `alt+<letter>` namespace to stop colliding with pi-ai's `ctrl+<letter>` editor/app defaults (`ctrl+o` `app.tools.expand`, `ctrl+t` `app.thinking.toggle`, etc.): abort/dismiss `Ctrl+X` → **`alt+x`**, inspect (navigate mode) `Ctrl+O` → **`alt+o`**, toggle thinking in the agent-detail overlay `Ctrl+T` → **`alt+t`** (AUTO toggle was already `alt+a`). Abort and inspect now register through pi's keybinding manager (`flow.abort`, `flow.inspect`), so they are rebindable via `~/.pi/agent/keybindings.json` and inert outside flow UI. Modal navigation (arrows/Enter/Esc/Backspace) is unchanged.

- **BREAKING (behavioral):** a soft-eligible failure on a node with **no `on_error`** now **hard-fails the flow** (fail-fast) instead of silently continuing. Flows that relied on silent continuation must add an `on_error` target to the node to keep going.
- **BREAKING (validation):** template references are now validated **fail-loud at flow-load**. `${{result.X}}` / `${{result.X.field}}` is a hard error when `X` is an unknown step, when `.field` is neither a declared output (agent/code node) nor a standard field (`summary`/`status`/`fullOutput`), or when `X` is not ordered before the referencing step (via transitive `blockedBy` or `on_complete`/`on_error`/branch/loop routing). The engine does not auto-add the edge. Existing flows with typos or undeclared dependencies will now fail validation instead of silently expanding to empty strings.
- **Loop iteration counter is 1-based and consistent** — the loop body executing pass N and the loop-decision step now both observe `${{loop.STEP.iteration}} == N` (the first body pass sees `1`, not `0`).
- **Removed the dead `reads` step field** — it was parsed but never consumed. File-content injection is provided by the agent `context_files` frontmatter field.

### Removed

- **BREAKING:** the **`conditional`** step type is removed (superseded by `code-decision`). Migrate: replace `type: conditional` with `type: code-decision`, read the value previously in `check: <stepId>.<key>` as a handler **input**, and return `{ branch: "present" }` or `{ branch: "absent" }` with `branches: { present: <present-target>, absent: <absent-target> }`. Standard fields (`summary`/`status`/`fullOutput`) remain available as `${{result.<stepId>.<field>}}` inputs. The parser rejects `type: conditional` with this migration hint.
- **BREAKING:** the **`agent-loop-decision`** step type is removed (a loop is now a backward `*-decision` branch). Migrate: replace `type: agent-loop-decision` with `type: agent-decision`, move `loop_target`/`exit_target` into `branches:` (e.g. `branches: { rework: <loop_target>, done: <exit_target> }`), and keep `max_iterations`. The agent calls `finish(branch="rework")` or `finish(branch="done")`. The parser rejects `type: agent-loop-decision` with this migration hint.
- Corrected the `code-node` spec wording: a successful code node sets `files` to `[]` (a `ResultFile[]`), not `""`.
- **Declared agent outputs are now REQUIRED by default** (behavior change). The finish-tool schema makes each declared output a required, optionally pattern-/type-constrained string, so a non-conforming `finish` call is rejected by the SDK and re-prompted via the existing finish retry loop; the step fails after `MAX_FINISH_RETRIES`. Existing agents that declared outputs but sometimes omitted them will now be retried/failed (mitigated by the retry loop).

## [v0.2.4] - 2026-06-23

### Added

- **Flow-run session persistence** (`extensions/flow-engine/flow-persist.ts`) — the `EventEmitObserver` now durably records every flow-run lifecycle event into the pi session via `pi.appendEntry("flow-event", …)` (record shape `FlowEventRecord { seq, eventType, data, flowRunId }`, `eventType` = the mapped dashboard protocol name). Persistence is additive and best-effort. This is the engine half of reload survival; the dashboard replay half is delegated (see `openspec/changes/persist-flow-runs/DASHBOARD-DELEGATION-BRIEF.md`). Architect events are a scoped-out follow-up.
- **`flow:agent-error` event** — emitted for step-level agent failures (derived at the `FlowManager.onAgentComplete` fan-out when `result.success === false`), giving the dashboard `{kind:"error"}` timeline entry a producer. Added `onError` to the `FlowObserver` interface. Tool errors still travel via `flow:subagent-tool-result`.
- **Orphaned-flow reconciliation on resume** (`flow-orphan-reconciliation` capability) — a flow lives and dies with its parent process, so a hard kill left a non-terminal persisted stream that hung the dashboard card on "running" with a no-op Abort. On `session_start`, `findOrphanedRun()` now scans persisted `flow-event` entries; a run with no terminal `flow_complete` is reconciled by emitting `flow:complete` live and persisting a `flow_complete` tagged with the orphan's `flowRunId` (status `aborted`), with `seedSeq()` keeping the synthesized terminal ordered after mid-run events. `flow:abort` now reconciles when no flow is live instead of silently no-opping. No `pi-agent-dashboard` change required.
- **Flush-gate marker swallow fix** — `FlowEventPersister` markers now carry a complete zero `Usage` (incl. `cost`). Without it, on resume pi's `_findLastAssistantMessage()` returns the marker and the next user send threw in `calculateContextTokens(usage.totalTokens)`; the throw was swallowed by `emitError`, silently dropping the user's message.

## [v0.2.3] - 2026-06-05

### Changed

- **Release workflow hardening** (`.github/workflows/publish.yml`) — the `publish` job now verifies `package.json` matches the resolved tag and fails loud on drift, instead of trusting an unbumped tag. `prepare` remains the single source of truth for versioning.
- **`prepare` commit is skip-if-clean** — the `Commit, tag, and push` step no longer hard-fails when the tree is already at the target version (CHANGELOG already dated, no version delta). It skips the commit + branch-push and still tags + pushes the tag so `publish` proceeds.

## [v0.2.2] - 2026-06-05

### Added

- **CI workflow** (`.github/workflows/ci.yml`) — runs `lint + typecheck + test` on Node 20, 22, 24 for every push to `develop` and every pull request.
- **Release workflow** (`.github/workflows/publish.yml`) — three jobs (`prepare`, `publish`, `github-release`). Triggered by tag-push (`v*`) or `workflow_dispatch` with version input. Publishes to npm with `--provenance` via Trusted Publishing (OIDC), gated by the `npm-publish` GitHub environment. Drafts a GitHub Release with notes extracted from the matching CHANGELOG section.
- **`tsconfig.json`** at repo root — strict mode, `noEmit`, ES2022 / `bundler` resolution; powers the new `typecheck` script.
- **ESLint flat config** (`eslint.config.js`) — `@eslint/js` + `typescript-eslint` recommended, tuned for the existing codebase.
- **`docs/releasing.md`** + **`agent-docs/releasing.md`** — operator runbook for the release workflow (human + caveman mirror).
- **CI status badge** in `README.md`.

### Changed

- Fixed 19 pre-existing TypeScript errors surfaced by the new `typecheck` step — API drift against `@earendil-works/pi-coding-agent@^0.74.0`. Touches: tool registrations (`label` field), `AgentResult` error-path returns, `ExtensionUIContext` stub, `FlowStep.blockedBy` narrowing, and small call-site signatures. No runtime behaviour change.
- `package.json` — added `lint`, `typecheck` scripts; added `eslint`, `@eslint/js`, `typescript-eslint`, `typescript`, `@types/node` to `devDependencies`.
- `AGENTS.md` — expanded "Running, Testing, Deploying" table to cover `lint`, `typecheck`, `CI`, and the new release workflow.
- `.gitignore` — removed `package-lock.json` so the lockfile is committed (required by `npm ci` in CI).

## [0.2.0] - 2026-05-15

### Changed

- **Tracked upstream npm scope migration.** All three pi-namespace peers and matching devDependencies renamed from `@mariozechner/*` to `@earendil-works/*` and bumped from `^0.69.0` to `^0.74.0`:
  - `@mariozechner/pi-ai` → `@earendil-works/pi-ai`
  - `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`
  - `@mariozechner/pi-tui` → `@earendil-works/pi-tui`

  Upstream `pi-coding-agent` 0.74.0 moved the entire `pi-mono` workspace to the `@earendil-works/*` scope and relocated the repo to `earendil-works/pi-mono`. The old `@mariozechner/*` scope is frozen at 0.73.1. This is a **breaking change for consumers** — projects pinning the old scope must migrate their lockfiles.

### Compatibility notes (0.69 → 0.74)

Skipped releases include several breaking changes. Audit before consumption:
- **0.72** — `compat.reasoningEffortMap` replaced with model-level `thinkingLevelMap`. If a flow registers providers/models with `reasoningEffortMap`, migration required.
- **0.71** — built-in Google Gemini CLI and Antigravity providers removed.
- **0.69** — `session_replacement` invalidates captured `pi` / command `ctx` after `newSession()` / `fork()` / `switchSession()`; long-lived references must move into the `withSession` callback.
- **0.69** — TypeBox 1.x migration upstream; the legacy `@sinclair/typebox` 0.34.x alias still loads, no change required for pi-flows today.

## [0.1.1] — Unreleased

### Added

- **Additive emission of `flow:architect-error` alongside `flow:architect-init-error`.** All six init-error sites in `extensions/flow-workspace/index.ts` now emit a parallel `flow:architect-error` event with `{ phase: "init", reason, message }`. Surfaces architect init failures in the dashboard via the existing `FLOW_EVENT_MAP["flow:architect-error"]` mapping without renaming the TUI-internal event.
- **Additive emission of `flow:architect-cancelled` alongside `flow:architect-abort`.** The Ctrl+X abort in `extensions/flow-engine/flow-tui.ts` now also emits `flow:architect-cancelled` with `{ reason: "user-abort" }`. Surfaces user-initiated aborts in the dashboard via the existing `FLOW_EVENT_MAP["flow:architect-cancelled"]` mapping.
- **`flow:summary-started` event** emitted at the top of the `flow:complete` handler in `extensions/flow-summary/index.ts`. Dashboard observers can now render a "generating summary…" intermediate state. Matches the existing `flow:summary-ready` lifecycle event symmetrically.
- **`docs/dashboard-integration.md`** explaining the two-repo split: pi-flows owns the engine + events; pi-agent-dashboard's `packages/flows-plugin/` owns the React reaction. Documents why source relocation to pi-flows is not planned (the dashboard's primitive-registry pattern supersedes it). Linked from `README.md`.

### Changed

- **peerDependencies pinned away from `"*"`.** All four pi-namespace peers (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`) and matching `devDependencies` now declare real semver caret ranges (`^0.69.0` and `^0.34.49` respectively, matching the versions in CI). The package is now publishable on npm without peer-range warnings; no install-graph change for existing users (caret of currently installed version satisfies itself).

### Notes

- OpenSpec change: `align-with-dashboard-plugins`.
- Cross-repo follow-up in `pi-agent-dashboard` documented as a delegation brief inside the change folder: removes the stale "pi-flows intentionally NOT bundled until license declared" comment in `packages/shared/src/recommended-extensions.ts` and adds `"pi-flows"` to `BUNDLED_EXTENSION_IDS` (pi-flows has MIT `LICENSE` since `fe5f119`).
