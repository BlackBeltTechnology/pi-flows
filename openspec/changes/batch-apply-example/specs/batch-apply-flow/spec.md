# Spec Delta

## Purpose

Provides a universal, opt-in example `batch:apply` flow that applies several specced OpenSpec changes in parallel worktrees, merges them onto one integration branch, reviews and gates the result, and asks the operator when an agent has questions.

## ADDED Requirements

### Requirement: batch:apply ships as an installable example, not a default flow

pi-flows SHALL ship `batch:apply`, its agents and its skill under `examples/`, SHALL NOT register them through discovery, and SHALL offer `/flows:examples` to list examples and `/flows:examples install <name> [--scope user|project] [--force]` to copy them into the user (default) or project flows and skills folders. Install SHALL NOT overwrite existing files without `--force`.

#### Scenario: Not registered by default
- **GIVEN** pi-flows installed and no example installed
- **WHEN** a session starts
- **THEN** no `/batch:apply` command SHALL be registered

#### Scenario: Install to user scope
- **WHEN** the user runs `/flows:examples install batch-apply`
- **THEN** the flow bundle and agents SHALL be copied under `<agentDir>/flows/` AND the skill under `<agentDir>/skills/` AND `/batch:apply` SHALL be available in every project

#### Scenario: Existing files kept
- **GIVEN** `<agentDir>/flows/flows/batch/apply/flow.yaml` already exists
- **WHEN** the user installs the example without `--force`
- **THEN** no file SHALL be overwritten AND the command SHALL name the existing path

### Requirement: batch:apply checks its prerequisites

Once installed, `batch:apply` SHALL work in any project with `git` and the `openspec` CLI. Before any worktree is created the flow SHALL check both tools and that every planned change validates (`openspec validate --strict`), and SHALL refuse to start otherwise, naming what is missing.

#### Scenario: Available in a fresh project
- **GIVEN** the example installed at user scope AND a git repository with `openspec/changes/a/` specced
- **WHEN** the user runs `/batch:apply` with a plan for `a`
- **THEN** the flow SHALL start without any project-local flow files

#### Scenario: openspec missing
- **WHEN** the `openspec` CLI is not on PATH
- **THEN** the flow SHALL stop before creating worktrees with an error naming `openspec`

### Requirement: Gates come from configuration or detection

The full gate SHALL run the `gates` commands from `.pi/batch.json` in order. Without them it SHALL use detected `package.json` scripts (`npm ci`, then `lint`, `typecheck`, `test`, `build` when defined). With neither, the flow SHALL refuse to start and name `.pi/batch.json`. The e2e gate SHALL run only when `e2e` is configured.

#### Scenario: Detected gates
- **GIVEN** no `.pi/batch.json` AND `package.json` scripts `lint`, `test`
- **WHEN** the full gate runs
- **THEN** it SHALL run `npm ci`, `npm run lint`, `npm test` in that order

#### Scenario: No e2e configured
- **WHEN** `.pi/batch.json` has no `e2e`
- **THEN** the e2e step SHALL be skipped AND the report SHALL say it was not configured

### Requirement: Changes are applied in dependency waves without idle agents

Each wave SHALL apply every ready change (dependencies merged-ready) with one agent per change, bounded by the plan's slot count, and SHALL spawn no agent for unused capacity.

#### Scenario: Two changes, no idle agents
- **GIVEN** a plan with two independent changes AND 4 slots
- **WHEN** the first wave runs
- **THEN** exactly two applier agents SHALL be spawned

#### Scenario: Dependency waits
- **GIVEN** change `b` depends on `a`
- **WHEN** wave 1 runs
- **THEN** `b` SHALL NOT be applied before `a` is done AND `b`'s worktree SHALL contain `a`'s commits

### Requirement: Manual tasks never block a change

An open task whose text contains `manual`, `NOT RUN`, `live pi session` or `real pi session` (case-insensitive) SHALL NOT block its change; the report SHALL list it as left to the operator.

#### Scenario: Manual check left open
- **GIVEN** a change whose only open task is `9.2 Manual: run a flow in a live pi session`
- **WHEN** the wave is collected with the change committed, clean and gates green
- **THEN** the change SHALL be `done` AND the report SHALL list task 9.2 for the operator

### Requirement: Agent questions reach the operator

When an applier finishes with outcome `blocked` and open questions, and the session is interactive, the flow SHALL ask the operator with the questions shown and a free-text answer allowed, and SHALL re-apply that change with the answer as input. In autonomous mode the change SHALL stay blocked and its questions SHALL appear in the report.

#### Scenario: Answer feeds the re-apply
- **GIVEN** an applier blocked with question "Keep the old flag?"
- **WHEN** the operator answers "No, remove it"
- **THEN** the next apply of that change SHALL receive "No, remove it" in its input

#### Scenario: Autonomous mode
- **WHEN** an applier is blocked with questions in autonomous mode
- **THEN** no prompt SHALL be shown AND the report SHALL list the questions

### Requirement: Merge, review and gates produce one integration branch

Done changes SHALL be squash-merged onto `batch/<name>` in plan order, with code conflicts handed to a resolver agent and verified (no markers, clean tree, expected subject). The merged branch SHALL be reviewed against the specs and gated, with fixer loops bounded at three attempts per gate. The run SHALL end with `report.md` (green, partial or red) and SHALL be resumable from its state file.

#### Scenario: Resolved conflict continues the merge
- **WHEN** the resolver agent resolves a conflict and finishes with outcome `resolved`
- **THEN** the flow SHALL verify the resolution AND continue merging the next change

#### Scenario: Resume
- **GIVEN** a run stopped after wave 1
- **WHEN** `/batch:apply` is started with the same plan
- **THEN** finished changes SHALL be kept AND unfinished ones re-assigned
