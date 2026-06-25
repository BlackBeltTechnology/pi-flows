# pi-flows

## Project Overview

`@blackbelt-technology/pi-flows` — a **pi-package** that adds multi-agent workflow orchestration to [pi](https://github.com/earendil-works/pi-coding-agent). Flows are YAML DAGs of agent steps, scheduled in parallel, rendered in a live TUI dashboard.

- **Type:** pi-package (`pi.extensions` manifest in `package.json`). No build step — `main` points directly at `./extensions/index.ts`, executed by pi at load time.
- **Runtime peer:** `@earendil-works/pi-coding-agent ^0.74.0` (plus `pi-ai`, `pi-tui`, `@sinclair/typebox`).
- **Companion repo:** [`pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) — browser-side flow rendering lives there as a workspace plugin. pi-flows emits `flow:*` events; the dashboard reacts.

## STOP — Docs-First Gate

`docs/` holds human-readable reference prose. **Before any build / run / install / deploy / authoring / "how do I X" question: `grep -ni <keyword> README.md docs/*.md` FIRST.** No source reads until that returns nothing.

- ❌ User: "how do I write a flow?" → read `extensions/flow-engine/*.ts` → guess
- ✅ User: "how do I write a flow?" → `grep -ni 'fork\|code-decision' docs/flows.md` → quote

If grep finds nothing, then read source.

## Running, Testing, Deploying

| Task | Command | Notes |
|---|---|---|
| Install in pi (from npm) | `pi install npm:pi-flows` | End-user install. |
| Install local clone | `pi install /path/to/pi-flows` | Dev workflow — pi reads `extensions/index.ts` directly, no build. |
| Lint | `npm run lint` | ESLint flat config in `eslint.config.js`. Scope: `extensions/`, `__tests__/`. |
| Typecheck | `npm run typecheck` | `tsc --noEmit` against `tsconfig.json`. Required for CI. |
| Run tests | `npm test` | Vitest, one-shot. Suites in `__tests__/`. |
| Watch tests | `npm run test:watch` | |
| CI | — | `.github/workflows/ci.yml` runs `lint + typecheck + test` on Node 20/22/24 for every push to `develop` and every PR. |
| Publish | Trigger `Release` workflow in GitHub Actions UI with version input, OR push a `v*` tag | `.github/workflows/publish.yml`. Trusted Publishing via OIDC (`--provenance`), gated by `npm-publish` GH environment. Drafts GitHub Release from CHANGELOG section. See `docs/releasing.md`. |
| Use flows in a session | `/flows`, `/flows:delete`, `/skill:edit-flow`, `/roles`, `alt+a`, `alt+x`, `alt+o` | Each flow is a self-contained dir `.pi/flows/flows/<namespace>/<name>/` with `flow.yaml`; auto-registers as `/<namespace>:<name>`. Authoring via `flow_agents`/`flow_write` (gated by `flows.editFlow`). |

There is **no compile / bundle / dist step**. TypeScript runs straight from `extensions/` via pi's loader. Treat `extensions/index.ts` as the entrypoint.

## Repository Layout

| Path | Purpose |
|---|---|
| `extensions/` | TypeScript source. Entrypoint `index.ts`. Subdirs: `flow-engine/`, `flow-dashboard/`, `flow-context/`, `flow-summary/`, `flow-workspace/`, `shared/`. |
| `agents/` | Built-in agents shipped with the package: `flow-decision.md`, `project-context-reader.md`. |
| `docs/` | Human-readable reference docs. For users + prose answers. Grep here first. |
| `__tests__/` | Vitest suites. |
| `openspec/` | Spec-change proposals (see OpenSpec conventions below). |
| `research/` | Exploratory notes, not shipped. |

## Documentation Pointers

Grep `docs/<file>.md` (and `README.md`) before reading source:

- `README.md` — overview, install, quick start, command list.
- `flows.md` — step types (agent, fork, conditional, agent-loop-decision, flow-ref) with syntax.
- `agents.md` — agent frontmatter schema, model tiers, card types.
- `flow-authoring.md` — full format reference for agent + flow files.
- `architecture.md` — DAG execution, agent isolation, sub-extensions.
- `events-api.md` — register custom cards / tools, listen to `flow:*` events.
- `public-api.md` — exported TypeScript types and functions.
- `tools-reference.md` — built-in tools available to agents.
- `skills-and-extensions.md` — skill bundles + extension registration.
- `creating-packages.md` — author a downstream pi-flow package.
- `extending-pi-flows.md` — advanced customization hooks.
- `dashboard-integration.md` — wire protocol between pi-flows and pi-agent-dashboard.
- `releasing.md` — operator runbook for cutting releases via `.github/workflows/publish.yml`.

## Code Instructions

Behavioral guidelines to reduce common LLM coding mistakes. Bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask via `ask_user`.
- Multiple interpretations → present them, don't pick silently.
- Simpler approach exists → say so. Push back when warranted.
- Unclear → stop, name the confusion, ask.
- **Never speculate about code you have not opened.** If the user references a file, read it before answering. No claims about the codebase without investigation.
- Before any major change, confirm the plan with the user.

### 2. Simplicity First

- Minimum code that solves the problem. Nothing speculative.
- No abstractions for single-use code.
- No "flexibility" / "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- 200 lines that could be 50 → rewrite.
- **DRY** only when a pattern appears in multiple places. Don't pre-extract for a single call site.

### 3. Surgical Changes

- Touch only what you must.
- Don't refactor adjacent code, comments, or formatting.
- Match existing style.
- Pre-existing dead code → mention, don't delete.
- Orphans created by your changes → clean up.

Test: every changed line traces directly to the user's request.

### 4. Goal-Driven Execution (TDD)

Transform tasks into verifiable goals. Tests first, verify they fail, then minimal implementation to pass. State a brief numbered plan with per-step verification for multi-step work.

### 5. Communication

- Summarise what changed at every step — no naked diffs.
- Use `ask_user` (not plain-text questions) for clarification, confirmation, or choices.

## Documentation Update Protocol

**Default assumption: your update does NOT belong in AGENTS.md.** Route by kind:

| Kind of update | Goes in |
|---|---|
| Flow / agent step syntax, semantics | `docs/flows.md` or `docs/agents.md` |
| New flow format feature, full reference | `docs/flow-authoring.md` |
| Internal design, execution model, isolation | `docs/architecture.md` |
| Event names, custom card registration | `docs/events-api.md` |
| Exported types / functions | `docs/public-api.md` |
| New built-in tool | `docs/tools-reference.md` |
| End-user install, quick start, commands | `README.md` |
| Release notes | `CHANGELOG.md` |
| Cross-cutting rule EVERY agent needs EVERY turn (rare) | AGENTS.md, ≤ 200 chars per row |

Rules:

1. AGENTS.md rows stay ≤ 200 characters. No change-history. No "See change: …" parentheticals.
2. Long-form rationale, protocol details → `docs/`. Reference from AGENTS.md with a one-line pointer.
3. New topic → add `docs/<topic>.md`. Add a one-line pointer under **Documentation Pointers** above.
4. **Every write under `docs/` MUST be delegated to a general-purpose subagent.** Main agent orchestrates, never edits `docs/` directly. `docs/` writes are normal prose. README.md and CHANGELOG.md may be edited directly.

## OpenSpec Conventions

Place change artifacts at `openspec/changes/<name>/` — never nested under `active/` or `archive/`. Use `openspec change new <name>` CLI to scaffold.

## Diagram Style

Mermaid (```mermaid blocks), not ASCII boxes. Applies to design docs, explore output, all artifacts.
