# pi-flows

## Project Overview

`@blackbelt-technology/pi-flows` — a **pi-package** that adds multi-agent workflow orchestration to [pi](https://github.com/earendil-works/pi-coding-agent). Flows are YAML DAGs of agent steps, scheduled in parallel, rendered in a live TUI dashboard.

- **Type:** pi-package (`pi.extensions` manifest in `package.json`). No build step — `main` points directly at `./extensions/index.ts`, executed by pi at load time.
- **Runtime peer:** `@earendil-works/pi-coding-agent ^0.74.0` (plus `pi-ai`, `pi-tui`, `@sinclair/typebox`).
- **Companion repo:** [`pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) — browser-side flow rendering lives there as a workspace plugin. pi-flows emits `flow:*` events; the dashboard reacts.

## STOP — Docs-First Gate

**Two doc trees:**
- `docs/` — human-readable prose. Reference when answering the user or writing prose for humans.
- `agent-docs/` — caveman-style mirror of `docs/`. **This is what agents read for grounded answers.** Same filenames, terser content.

**Before any build / run / install / deploy / authoring / "how do I X" question: `grep -ni <keyword> README.md agent-docs/*.md` FIRST.** Fall back to `docs/*.md` only if the topic isn't mirrored yet. No source reads until both return nothing.

- ❌ User: "how do I write a flow?" → read `extensions/flow-engine/*.ts` → guess
- ✅ User: "how do I write a flow?" → `grep -ni 'fork\|conditional' agent-docs/flows.md` → quote

If grep finds nothing in either tree, then read source.

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
| Publish | Trigger `Release` workflow in GitHub Actions UI with version input, OR push a `v*` tag | `.github/workflows/publish.yml`. Trusted Publishing via OIDC (`--provenance`), gated by `npm-publish` GH environment. Drafts GitHub Release from CHANGELOG section. See `docs/releasing.md` / `agent-docs/releasing.md`. |
| Use flows in a session | `/flows`, `/flows:new`, `/flows:edit`, `/flows:delete`, `/roles`, `Ctrl+A`, `Ctrl+X` | Flow files at `.pi/flows/flows/<name>.yaml` auto-register as `/<name>`. |

There is **no compile / bundle / dist step**. TypeScript runs straight from `extensions/` via pi's loader. Treat `extensions/index.ts` as the entrypoint.

## Repository Layout

| Path | Purpose |
|---|---|
| `extensions/` | TypeScript source. Entrypoint `index.ts`. Subdirs: `flow-engine/`, `flow-dashboard/`, `flow-context/`, `flow-summary/`, `flow-workspace/`, `shared/`. |
| `agents/` | Built-in agents shipped with the package: `flow-architect.md`, `flow-decision.md`, `project-context-reader.md`. |
| `docs/` | Human-readable reference docs. For users + prose answers. |
| `agent-docs/` | Caveman-style mirror of `docs/` for agent consumption. Same filenames. Grep here first. |
| `__tests__/` | Vitest suites. |
| `openspec/` | Spec-change proposals (see OpenSpec conventions below). |
| `research/` | Exploratory notes, not shipped. |

## Documentation Pointers

Grep `agent-docs/<file>.md` first (caveman, for agents). Fall back to `docs/<file>.md` (human-readable) if not yet mirrored. Same filenames in both trees:

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
3. New topic → add `docs/<topic>.md` (human) AND `agent-docs/<topic>.md` (caveman). Add a one-line pointer under **Documentation Pointers** above.
4. **Every write under `docs/` or `agent-docs/` MUST be delegated to a general-purpose subagent.** Main agent orchestrates, never edits these trees directly.
   - `docs/` writes: normal prose, no caveman constraint.
   - `agent-docs/` writes: pass the caveman-style rule below verbatim in the subagent's prompt.
   - When a `docs/<topic>.md` change lands, mirror the substance into `agent-docs/<topic>.md` in the same task (separate subagent call is fine).

   **Caveman style** (`agent-docs/` only):
   - Short declarative fragments. Drop articles (a/an/the) and most copulas when meaning survives.
   - Subject → verb → object, present tense. No hedging, no "we", no "you".
   - One fact per line/row.
   - Prefer concrete tokens (paths, function names, env vars, exit codes) over prose.
   - Symbols/identifiers verbatim; only connective tissue compresses.
   - Verbose: "This module is responsible for parsing input and dispatching to the correct handler." Caveman: "Parses input. Dispatches to handler by command prefix."

## OpenSpec Conventions

Place change artifacts at `openspec/changes/<name>/` — never nested under `active/` or `archive/`. Use `openspec change new <name>` CLI to scaffold.

## Diagram Style

Mermaid (```mermaid blocks), not ASCII boxes. Applies to design docs, explore output, all artifacts.
