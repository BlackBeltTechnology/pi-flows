# Changelog

All notable changes to pi-flows will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
