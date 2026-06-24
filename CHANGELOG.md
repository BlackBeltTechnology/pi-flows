# Changelog

All notable changes to pi-flows will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`code` step type** (`code-node` capability) — run deterministic TypeScript as a first-class DAG node, wired exactly like an agent. A code node's handler is the **default export** of a `.ts` module, invoked `(input, ctx)`: declared `inputs:` are template-expanded to strings; the returned object must contain exactly the declared `outputs:` (primitive values coerced via `String()`, objects/arrays/null rejected) and is merged into the result context as typed outputs. `ctx: CodeNodeContext` (exported from the package, alongside `CodeNodeHandler<I,O>`) carries `signal`, `cwd`, `logger`, `setSummary`, `flowName`, `stepId`, and `task`. Handlers run in-process (jiti dynamic import) with cooperative `AbortSignal`; an optional `timeout` is a soft deadline. Failure routing follows the node-failure-model: a plain `throw` (or a contract/coercion/missing-handler/timeout failure) is **soft**, `throw new FlowHardError(msg)` is **hard**.
- **Code-node handler generation** — on every successful `flow_write` (and via the new `/flows:generate <name>` command), pi-flows writes an inert `<id>.ts.default` reference template at `.pi/flows/handlers/<flow>/<id>.ts.default` with `Input`/`Output` interfaces derived from the node's `inputs`/`outputs` and a default-export stub. Copy it, drop `.default`, and implement the body. Templates are always regenerated and never touch the real `.ts`; nodes with a custom `target:` get no template. When a real handler exists, a non-fatal **drift warning** flags a mismatch between its `interface Input`/`Output` blocks and the YAML.
- **`conditional` typed-output resolution** — `check: <stepId>.<key>` now resolves any typed-output key from the merged result map (falling back to `fullOutput` only when the key is absent), so conditionals can branch on a code node's (or agent's) typed outputs. Standard fields `artifacts`/`summary`/`files`/`status` resolve as before.
- **Unified node failure model** (`node-failure-model` capability) — every node now resolves to exactly one outcome: `success`, `soft`, or `hard`. `success` routes `on_complete`; a `soft` failure routes `on_error`; a `hard` failure aborts in-flight parallel steps, skips pending steps, and ends the flow with status `error` and the failure message surfaced in the flow result. Agent failures are classified **structurally** (no error-message parsing): `finish(complete)` → success, `finish(error|blocked)` → soft, no-finish **with** a terminal API error → hard, no-finish **without** an API error → soft. The no-finish nag is capped at 2 reminders, then a clean soft failure (no more `status:"unknown"`).
- **`FlowHardError`** — exported from the package entrypoint. Code/extension nodes signal an unconditional hard stop with `throw new FlowHardError(msg)`; a plain `throw` is soft. Also exports the `FailureOutcome` / `FailureInfo` types and the `classifyAgentOutcome` / `classifyThrownError` / `resolveRouteOutcome` helpers.
- pi-flows relies on pi-coding-agent's built-in transient-error retry and adds **no** redundant retry layer; an agent error reaching the engine is terminal.
- **Agent node contract enhancements** (`enhance-agent-node-contract`) — three additive agent frontmatter fields plus enforced outputs:
  - **`fork_session: true|false`** (default `false`) — opt-in to inherit the operator's main-session conversation data. When set, the spawned agent's session is forked from the operator's persisted session file via the SDK `SessionManager.forkFrom`; falls back to a fresh in-memory session when the main session is not persisted. Agent writes land in the fork, not the operator's live session.
  - **`context_files: [paths]`** — each path is read at spawn and injected into the agent's system prompt as a `## Context: <path>` preamble section. Missing/unreadable files are skipped (non-fatal). `AGENTS.md` is just one possible path.
  - **Output `type` / `pattern` constraints** — declared `outputs` entries accept optional `type: string|number|boolean` and `pattern: <regex>`. Values stay string-valued downstream; the constraints validate the string content (`number` → numeric string, `boolean` → `true`/`false`, `pattern` → regex match). Explicit `pattern` wins over `type`; an invalid regex degrades to an unconstrained required string.
  - First test coverage for agent parsing, finish-tool schema construction, output validation, context-file loading, and the fork/in-memory session decision.

### Changed

- **BREAKING (behavioral):** a soft-eligible failure on a node with **no `on_error`** now **hard-fails the flow** (fail-fast) instead of silently continuing. Flows that relied on silent continuation must add an `on_error` target to the node to keep going.
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
