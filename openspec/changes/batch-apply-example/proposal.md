# Proposal: batch-apply-example

## Why

`batch:apply` (born in invoice-bot, copied locally into pi-flows) applies several specced OpenSpec changes at once. It runs test-first agents in parallel git worktrees respecting dependencies, squash-merges them onto one integration branch, has conflicts resolved by an agent, reviews the result against the specs, and runs the project's gates with a fixer loop. It is the most complete real multi-agent flow we have, and the best demonstration of pi-flows. Today it only works in the project it was written for: gates, e2e, paths and agent prompts are hard-coded, the four parallel slots are hand-wired, and empty slots spawn agents. Made universal and shipped as an **example** (not a registered default flow), it is the reference for real multi-agent flows, and anyone can install it into their user or project flows folder in one step.

## What Changes

- **Ship `batch:apply` as an example, never auto-registered.** It lives under `examples/flows/batch/apply/` (flow, handlers, planner), `examples/flows/agents/batch-*.md` and `examples/skills/batch-apply/SKILL.md`. pi-flows discovery does **not** scan `examples/`, so no `/batch:apply` command appears unless the user installs it.
- **Install command:** `/flows:examples` lists shipped examples; `/flows:examples install batch-apply [--scope user|project]` copies the flow and agents into `<agentDir>/flows/` (default, via `global-flow-location`) or `.pi/flows/`, and the skill into `<agentDir>/skills/` or `.pi/skills/`. It refuses to overwrite existing files unless `--force`. Copying by hand works too.
- **Universal configuration** from `.pi/batch.json` (optional):
  - `base` branch (default: the current branch)
  - `gates`: ordered `{ id, run }` commands. The default is detected from `package.json` scripts (`ci` → `npm ci`, then `lint`, `typecheck`, `test`, `build` when present); with no detection and no config, the flow refuses to start and names the file to create.
  - `e2e`: an optional `{ run, env? }`. Skipped by a two-branch decision when absent.
  - `worktreeSetup`: optional commands run in each new worktree (e.g. `npm ci`, a cache symlink).
  - `restorePaths`: optional paths tests dirty that are never part of a change.
  - `forbid`: commands agents must not run (advisory text in prompts; enforced only by an executor).
- **Dynamic fan-out:** the four `apply-N` slots become one `apply` fan-out lane: `plan-wave` is a `multi: true` code-decision returning `routes: [{ branch: apply, items }]`, one item per ready change (name and worktree path), `collect-wave` reads `${{result.apply.items}}` (`multi-route-decisions`). Optional gates and question handling use two-branch decisions.
- **Questions to the operator:** when an applier finishes `blocked` with open questions, a `fork` asks the operator (questions shown in the prompt, free-text answer allowed). The answer is passed to a re-apply of that change in the next wave. In autonomous mode the change stays blocked and the questions go to the report.
- **Manual tasks are the operator's:** open tasks containing "manual", "NOT RUN" or "live/real pi session" are listed in the report and never block a change.
- **Agent outputs use `outcome`** (not the reserved `status`).
- **Docs example:** `docs/examples/batch-apply.md` walks through the flow as the reference for fan-out, multi-route and two-branch decisions, code handlers, loops and operator feedback.

## Capabilities

### New Capabilities
- `batch-apply-flow`: the example flow's contract (opt-in install, not registered by default): plan input, configuration and gate detection, wave/merge/review/gate pipeline, operator questions, manual-task handling, report and resume.

### Modified Capabilities
<!-- none -->

## Impact

- **New files:** `examples/flows/batch/apply/` (flow.yaml + handlers + planner), `examples/flows/agents/batch-*.md`, `examples/skills/batch-apply/SKILL.md`, `docs/examples/batch-apply.md`, and the `/flows:examples` command. `package.json` `files` includes `examples/`; `pi.skills` does **not** (the skill is installed with the example).
- **Depends on:** `multi-route-decisions`, `fix-authoring-validator`. Uses `flow_run` if `flow-run-tool-and-starters` lands, otherwise the `/batch:apply` slash command (the start/status tools from the local copy are folded into the skill instructions).
- **Requires** `git` and the `openspec` CLI on PATH; the flow's preflight step checks both.
- **Depends on `global-flow-location`** for the default user-scope install target.
- **Local copy** in `.pi/` of this repo is replaced by installing the example once it works.

## Discipline Skills

`doubt-driven-review` (git operations on the user's repo: worktrees, branches, squash merges), `observability-instrumentation` (state.json, logs, report), `security-hardening` (commands from config run on the host).
