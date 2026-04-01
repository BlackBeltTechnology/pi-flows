# pi-flows

A [pi-package](https://github.com/badlogic/pi-mono) that adds multi-agent workflow orchestration to pi. Design flows as YAML files, run them with automatic parallel scheduling, and watch everything in a live dashboard — while the main session stays fully interactive.

---

## What It Solves

Flows are **workflow templates** that can be reused and created project-wise. Each user can create their own dedicated workflows that are tailored for the project.

Flows can have **multiple agents communicating with each other** through structured I/Os. These agents can be reused across multiple flows, and new agents can be created to suit their own specific tasks. Loops and forks are also available for when automatic validation and user-driven decision points are needed.

### The Goal

This tool lets each user turn their style of work into **subagent workflows** that suit their needs and their workstyle. It has a TUI for terminal use with custom metrics in cards, but can be wired into any dashboard frontend.

### Best Practice Usage

Flows should be used for **big, reusable tasks** that are commonly used in the project's development cycle. Think of them as your team's playbooks:

- **Research → Plan → Implement → Verify** cycles that you run on every feature
- **Code review** pipelines with automated checks and human decision points
- **Documentation generation** workflows that analyze code and produce docs
- **Refactoring** workflows with verification loops to ensure nothing breaks
- **Onboarding** flows that explore a codebase and produce summaries

**When to create a flow:**
- You find yourself repeating the same multi-step process regularly
- A task naturally decomposes into independent subtasks that can run in parallel
- You need a verify → fix → re-verify loop with a safety cap
- You want a user decision point (fork) to choose between approaches mid-workflow

**When NOT to use a flow:**
- Simple one-shot tasks — just use the main session directly
- Tasks that require constant back-and-forth conversation — flows are for structured pipelines

### Sub-extensions

pi-flows is composed of several tightly integrated sub-extensions, all loaded through a single entry point:

| Extension | Description |
|-----------|-------------|
| **provider-register** | Provider management, model auto-discovery, role assignment, autonomous mode state |
| **file-tracker** | Tracks file modifications (edit/write) in the main session for footer stats |
| **flow-engine** | Core orchestration: agent parsing, flow parsing, DAG execution, template expansion, tool registration |
| **flow-dashboard** | Live TUI dashboard with agent cards, grid layout, detail overlays, card registry |
| **flow-summary** | Post-flow summary widget with LLM-generated insights, result persistence |
| **flow-context** | Flow result management, `flow_results` tool, `/flows` action menu, delete/edit commands |
| **flow-workspace** | Flow creation and editing: Flow Architect spawning, staging directories, replan loop |
| **flow-footer** | Composable footer bar with provider/model, git branch, file stats, context usage, and extension segments |

---

## Table of Contents

- [What It Solves](#what-it-solves)
- [Install](#install)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Core Concepts](#core-concepts)
  - [Agents](#agents)
  - [Flows](#flows)
  - [DAG Execution](#dag-execution)
  - [Template Variables](#template-variables)
- [Writing Agents](#writing-agents)
  - [Frontmatter Fields](#frontmatter-fields)
  - [Available Tools](#available-tools)
  - [Model Roles](#model-roles)
  - [Role Presets](#role-presets)
  - [Model Discovery](#model-discovery)
  - [Access Control](#access-control)
  - [Skills Directory Format](#skills-directory-format)
  - [Dashboard Cards](#dashboard-cards)
- [Writing Flows](#writing-flows)
  - [Flow Frontmatter](#flow-frontmatter)
  - [Agent Steps](#agent-steps)
  - [Fork Steps](#fork-steps)
  - [Conditional Steps](#conditional-steps)
  - [Agent Decision Steps](#agent-decision-steps)
  - [Agent Loop Decision Steps](#agent-loop-decision-steps)
  - [Flow Reference Steps](#flow-reference-steps)
- [Input Wiring](#input-wiring)
- [Template Variable Reference](#template-variable-reference)
- [Dashboard](#dashboard)
- [Flow Architect](#flow-architect)
- [Flow Context](#flow-context)
- [Built-in Agents](#built-in-agents)
- [Footer Bar](#footer-bar)
- [Extending pi-flows](#extending-pi-flows)
- [Provider Management](#provider-management)
- [Requirements](#requirements)
- [Developer Docs](#developer-docs)
- [License](#license)

---

## Install

Global (available in all projects):

```bash
pi install git:github.com/BlackBeltTechnology/pi-flows
```

Local (project-only, saved to `.pi/settings.json`):

```bash
pi install -l git:github.com/BlackBeltTechnology/pi-flows
```

---

## Quick Start

### 1. Set up providers and model roles

Before running flows, assign models to roles so agents know which model to use:

```
/provider          Add an LLM provider (Anthropic, OpenAI, etc.)

/roles             Assign models to roles (@planning, @coding, @fast, etc.)
```

### 2. Create your first agent

Save this to `.pi/flows/agents/researcher.md`:

```markdown
---
name: researcher
description: Investigates the codebase and produces a summary
model: @research
tools: read, grep, bash
---

You are a research agent. Your task: ${{task}}

Investigate the relevant code thoroughly. Call `finish` when done with your summary.
```

### 3. Create a flow that uses it

Save this to `.pi/flows/flows/my-research.yaml`:

```yaml
name: my-research
description: Run a research pass on the codebase

steps:
  - id: researcher
    agent: researcher
    task: Investigate ${{task}}
```

### 4. Run the flow

Every saved flow auto-registers as a slash command:

```
/my-research       Find out how authentication works
```

The dashboard appears, the agent runs, and results are saved. The main session stays interactive the whole time.

### 5. Use the Flow Architect for complex flows

```
/flows:new         Design a multi-step flow interactively
```

The Flow Architect reads your existing agents and helps you design, validate, and save flows through conversation.

---

## Commands

| Command | Description |
|---------|-------------|
| `/flows` | Action menu — create, list, edit, or delete flows |
| `/flows:new` | Design and run a new flow interactively with the Flow Architect |
| `/flows:edit` | Modify an existing saved flow |
| `/flows:delete` | Remove a flow and its results |
| `/provider` | Add, list, or remove LLM providers |

| `/roles` | Assign models to named roles |
| `/<flow-name>` | Run a saved flow (auto-registered from `.pi/flows/`) |

---

## Core Concepts

### Agents

An **agent** is an AI worker defined by a `.md` file. It has a system prompt (the file body), a set of declared tools, a model role, and optional inputs. When dispatched, it runs as an in-process session that reads the task, uses its tools, and submits a structured result by calling `finish`.

- Agents live in `.pi/flows/agents/` (or a registered package directory)
- Each agent file = one worker definition
- Agents are reusable across multiple flows

### Flows

A **flow** is a pipeline of steps defined in a `.yaml` file. Steps can run in parallel or sequence, branch on user choices or agent decisions, loop iteratively, or delegate to sub-flows.

- Flows live in `.pi/flows/flows/`
- Each saved flow auto-registers as a `/command`
- Steps reference agents by name

### DAG Execution

Flow steps form a **directed acyclic graph** based on `blockedBy` declarations. Pi-flows schedules all steps that have no pending dependencies in parallel, respecting `max_concurrent` if set.

```
researcher ──────────────┐
                          ├──► developer ──► verifier ──► finalize
summarizer (parallel) ───┘
```

In this example, `researcher` and `summarizer` run simultaneously. `developer` starts only after both complete. Then `verifier` runs, followed by `finalize`.

### Template Variables

Steps communicate with each other through **template variables** — placeholders in `task`, `inputs`, and `question` fields that resolve to values from previous steps:

```yaml
## developer
agent: developer
blockedBy: researcher
task: Implement the changes. Research context: ${{result.researcher.summary}}
```

See the full [Template Variable Reference](#template-variable-reference) below.

---

## Writing Agents

Agents are `.md` files with a YAML frontmatter block followed by the system prompt body. Place them in `.pi/flows/agents/` or a package-registered agents directory.

```markdown
---
name: backend-developer
description: Implements backend changes based on research findings
model: @coding
thinking: high
tools: read, write, edit, bash, grep
skills: my-backend-docs
inputs:
  - research_output
card:
  label: "Developer"
  metric: "files"
architect:
  use_when: "When backend code changes are needed"
  produces: "Modified source files"
  depends_on: "research results"
  domain: "development"
access:
  write:
    - "src/**"
    - "tests/**"
  bash:
    deny:
      - "rm -rf *"
---

You are a backend developer. Your task: ${{task}}

Use the research context provided:
${{input.research_output}}

Focus on clean, tested implementations. Run the existing test suite after making changes.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|:--------:|-------------|
| `name` | ✓ | Unique agent identifier used in flows and the `/subagent` tool |
| `description` | ✓ | What this agent does (shown in the Flow Architect and dashboard) |
| `model` | ✓ | Model role (`@coding`, `@planning`, etc.) or a direct model ID |
| `tools` | ✓ | Comma-separated list of tools the agent can call |
| `thinking` | | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `skills` | | Skill name(s) whose docs are injected into the system prompt |
| `inputs` | | Named inputs this agent expects — declared as a contract for flow wiring |
| `outputs` | | Named output values extracted from `finish` params — accessible downstream as `${{result.STEP.name}}` |
| `interactive` | | Set to `true` if the agent should prompt the user mid-execution |
| `access` | | Sandboxing rules (see [Access Control](#access-control)) |
| `card` | | Dashboard card configuration (see [Dashboard Cards](#dashboard-cards)) |
| `architect` | | Metadata for the Flow Architect: `use_when`, `produces`, `depends_on`, `domain` |

### Available Tools

Declare these in the `tools:` field:

| Tool | Description |
|------|-------------|
| `read` | Read file contents (text and images) |
| `write` | Write or create files |
| `edit` | Surgical text replacement in existing files |
| `bash` | Execute shell commands |
| `grep` | Search file contents with regex (supports a `glob:` filter parameter) |
| `find` | Find files in directory trees (supports glob patterns) |
| `ls` | List directory contents |
| `skill_read` | Read documentation files from a skill |
| `ask_user` | Prompt the user for a selection, confirmation, or freetext input mid-execution. Requires `interactive: true` on the agent. |

> **`finish` is automatic.** Every agent automatically has the `finish` tool — do not declare it. Agents *must* call `finish` as their last action to submit structured results. Any tool calls after `finish` are blocked.

> **Extension tools:** Domain packages can register additional tools (e.g., `model_cli`) via `flow:register-tool`. An agent can declare and use them by adding the tool name to its `tools:` field. See [Extending pi-flows](#extending-pi-flows) and [docs/events-api.md](docs/events-api.md#flowregister-tool).

### Model Roles

Assign models to roles with `/roles`, then reference them with an `@` prefix:

| Role | Typical Use |
|------|-------------|
| `@planning` | Architecture, reasoning, high-level decisions |
| `@coding` | Code generation and modification |
| `@fast` | Quick tasks, routing decisions |
| `@research` | Investigation, analysis, reading |
| `@compact` | Summarization and short tasks |
| `@vision` | Image and visual analysis |

**Setup:** Run `/provider` to add a provider, then `/roles` to assign models to roles.

### Role Presets

Role assignments can be saved and loaded as **presets** — useful when switching between different model configurations (e.g., fast/cheap vs. high-quality, or different providers).

From `/roles`, select:

| Action | Description |
|--------|-------------|
| **Edit roles** | Change individual role → model assignments |
| **Save as preset** | Snapshot current roles under a named preset |
| **▶ preset-name** | Load a saved preset (overwrites current roles) |
| **Delete preset** | Remove a saved preset |

The active preset is shown with a `✓` prefix. Manually editing any role clears the active preset marker.

```
/roles
→ Save as preset → "fast-and-cheap"
→ (switch models)
→ Save as preset → "high-quality"
→ ▶ fast-and-cheap    ← load it back
```

> Presets are stored in `~/.pi/agent/providers.json` alongside provider credentials and role assignments.


### Model Discovery

Models are **automatically discovered** from your providers. When you add or edit a provider via `/provider`, pi-flows fetches the provider's `/v1/models` endpoint and registers all available models.

This means:
- No manual model catalog to maintain
- All models your provider offers are immediately available in `/roles`
- Adding a provider with 60+ models works out of the box

For custom model metadata (reasoning support, context window overrides), use `~/.pi/agent/models.json` which feeds into pi core's `ModelRegistry`.

> **Migration note:** The `/catalog` command and static model catalog have been removed. Models now come from provider auto-discovery. Existing `models` and `modelIds` fields in `providers.json` are silently ignored.

### Access Control

The `access` block restricts what an agent can read, write, and run. This sandboxes agents to prevent accidental damage. Enforcement is handled by the **guard extension**, which is automatically injected into every spawned agent session.

```yaml
access:
  read:
    - "src/**"
    - "docs/**"
  write:
    - "src/**"
  bash:
    deny:
      - "rm -rf *"
      - "curl *"
      - "sudo *"
```

- **`read`** — Glob patterns for allowed read paths. Reads outside these are blocked.
- **`write`** — Glob patterns for allowed write paths. Writes outside are blocked.
- **`bash.deny`** — Command patterns to block. Matched against the full `command` argument.

The guard also enforces:
- **Tool whitelist** — only tools declared in the agent's `tools:` field are allowed
- **`finish` requirement** — agents must call `finish` as their final action; post-finish tool calls are blocked
- **`ask_user` blocking** — blocked by default unless the agent has `interactive: true`
- **Decision branch validation** — for decision agents, `finish` must include a valid `branch` name

### Skills Directory Format

When you create a package (or project-local skills in `.pi/skills/`), each skill is a directory containing a `SKILL.md` file and optional detail files:

```
my-skills/
└── my-framework-docs/      # Skill directory name = skill name used in frontmatter
    ├── SKILL.md             # Required: injected into agent system prompt + lists detail files
    ├── api-reference.md     # Detail file (agent can read via skill_read tool)
    └── examples.md
```

**`SKILL.md`** serves a dual purpose:

1. **Prompt injection** — its entire content is prepended to the agent's system prompt when the agent declares the skill.
2. **Detail file registry** — lists the available detail files so the agent knows what to request via `skill_read`.

```markdown
# My Framework Docs

Brief overview of the framework that the agent should know upfront.

## Available Reference Files

Read these with `skill_read` for detailed information:

- `api-reference.md` — Full API reference
- `examples.md` — Common usage patterns
```

Agents discover and use skills via their frontmatter:

```yaml
skills: my-framework-docs   # Single skill
# or
skills:
  - my-framework-docs
  - another-skill
```

Skills registered by packages (via `flow:register-skills-dir`) take precedence over pi-flows' built-in skills. See [docs/extending-pi-flows.md](docs/extending-pi-flows.md) for registration details.

### Dashboard Cards

The `card` block controls how the agent appears on the live dashboard during flow execution:

```yaml
card:
  label: "Developer"      # Display label on the card
  metric: "files"         # Metric renderer (built-in: default, files, tests)
```

Custom metric renderers can be registered by extension packages via `flow:register-card`. See [Extending pi-flows](#extending-pi-flows).

---

## Writing Flows

Flows are `.yaml` files with top-level metadata fields and a `steps` array. Each step has an `id` field and either an explicit `type` field or an inferred type based on its fields (e.g., `question` → fork, `check` → conditional, `agent` → agent step). The step `id` is used for dependency wiring (`blockedBy`), result references (`${{result.ID.*}}`), and branching.

Save flows in `.pi/flows/flows/` to auto-register them as slash commands.

### Flow Frontmatter

```yaml
---
name: research-and-build
description: Research the codebase then implement changes
max_concurrent: 2
task_required: true
task_prompt: "What should I research and build?"
---
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `name` | ✓ | Flow identifier — for documentation; the actual slash command is derived from the file path (see note below) |
| `description` | ✓ | What the flow does (shown in command list and dashboard) |
| `max_concurrent` | | Maximum agents running in parallel (default: `4`) |
| `task_required` | | When `true`, prompts the user for a task if none was provided with the command |
| `task_prompt` | | Custom prompt text shown when asking for a task |

> **Command name = file path, not `name:` field.** The slash command for a flow is determined by its position in the flows directory, not the `name:` frontmatter value:
>
> | File path | Registered command |
> |-----------|-------------------|
> | `.pi/flows/flows/research.yaml` | `/research` |
> | `.pi/flows/flows/my-domain/research.yaml` | `/my-domain:research` |
>
> Subdirectories add a colon-separated prefix (max one level deep). Keep the frontmatter `name:` in sync for clarity, but know that pi-flows always uses the filesystem-derived name.

### Agent Steps

The default step type. Dispatches a named agent with a task. Each step has a unique `id` used for dependency wiring (`blockedBy`), result references (`${{result.ID.*}}`), and branching. The `agent:` field is **always required**.

```yaml
steps:
  - id: researcher
    agent: researcher
    task: Investigate the codebase for ${{task}}
```

When the same agent needs to run multiple times in a flow with different tasks, give each step a unique ID:

```yaml
steps:
  - id: create-draft
    agent: writer
    task: Write the initial draft

  - id: revise-draft
    agent: writer
    blockedBy: [create-draft]
    task: Revise the draft based on feedback
```

Wire dependencies and result references using the **step ID** (`blockedBy: [create-draft]`, `${{result.create-draft.summary}}`), not the agent name.

**All agent step fields:**

| Field | Description |
|-------|-------------|
| `id` | **Required.** Unique step identifier |
| `agent` | **Required.** Agent name to dispatch |
| `task` | Task override (template string). If omitted, uses the flow's task |
| `blockedBy` | Array of step IDs that must complete before this step starts |
| `inputs` | Named inputs wired from template expressions (see [Input Wiring](#input-wiring)) |
| `on_complete` | Step ID to route to on success |
| `on_error` | Step ID to route to on error |

### Fork Steps

Pause execution and ask the user a question, then branch based on their answer.

```yaml
  - id: choose-approach
    type: fork
    question: Which approach do you prefer?
    options: [Quick fix, Full refactor]
    branches:
      Quick fix: quick-fix-step
      Full refactor: refactor-step
```

**All fork step fields:**

| Field | Description |
|-------|-------------|
| `question` | Question to display to the user |
| `options` | Answer choices |
| `branches` | Map of option text → step ID to run |
| `allowCustom` | Appends "Other (describe)" option. Custom freetext routes through the fork's `agent` to pick the closest branch. Requires `agent`. |
| `multiSelect` | Allow selecting multiple options. All selected branches execute sequentially |
| `agent` | Agent for autonomous decisions (Ctrl+A) and custom freetext routing. Required when `allowCustom` is set. |
| `task` | Task description for the decision agent. Defaults to a prompt containing the question and options if omitted |

After the user picks an option, they are always prompted for optional notes (Enter to skip). Fork context (question, selected option, notes, and who decided) is **automatically injected** into the branch step's system prompt — no manual wiring needed.

> **`options:` format:** Options can be comma-separated inline (`options: fast, thorough`) or as a YAML list. Option text must exactly match the keys in `branches:`.

### Conditional Steps

Branch based on whether a field from a previous step's result is non-empty.

```yaml
  - id: check-research
    type: conditional
    check: researcher.artifacts
    present: fill-gaps-step
    absent: proceed-to-build
```

The `check` field is a `stepId.field` path. Supported fields: `artifacts` (default when no field given), `summary`, `files`, `status`. If the field's text content is non-empty, the `present` branch runs; otherwise `absent`.

| Field | Description |
|-------|-------------|
| `check` | `stepId` or `stepId.field` to check. Field defaults to `artifacts` if omitted. |
| `present` | Step ID to route to if the field is non-empty |
| `absent` | Step ID to route to if the field is empty or the step has no result |

### Agent Decision Steps

Delegate a routing decision to an agent. The agent analyzes the situation and calls `finish` with a `branch` name.

```yaml
  - id: route-decision
    type: agent-decision
    agent: router-agent
    task: "Review the analysis and decide what to do next: ${{result.analyzer.summary}}"
    branches:
      needs-work: fix-step
      ready: deploy-step
```

The decision agent must call `finish` with `branch: "needs-work"` or `branch: "ready"`. Any other branch name causes an error.

### Agent Loop Decision Steps

Iterative verify/fix cycles. The agent decides on each iteration whether to loop back or exit forward.

```yaml
  - id: verify-loop
    type: agent-loop-decision
    agent: verifier
    task: "Check if the implementation is correct: ${{result.developer.summary}}"
    loop_target: developer
    exit_target: finalize
    max_iterations: 3
```

- **`loop_target`** — Step ID to jump back to when the agent decides more work is needed
- **`exit_target`** — Step ID to continue to when the agent is satisfied
- **`max_iterations`** — Safety cap; forces an exit when exceeded

The decision agent calls `finish` with `branch: "developer"` (the `loop_target` step ID) to loop back, or `branch: "finalize"` (the `exit_target` step ID) to exit forward. If `max_iterations` is exceeded, the flow automatically exits to `exit_target`.

### Flow Reference Steps

Delegate execution to another flow file.

```yaml
  - id: run-tests
    type: flow-ref
    path: .pi/flows/flows/test-suite.yaml
    on_complete: deploy-step
    on_error: fix-step
```

---

## Input Wiring

**Inputs** let you pass specific data from one step to another in a structured way. This is different from embedding a template variable directly in the `task` — inputs allow agents to reference structured values via `${{input.NAME}}` rather than inlining potentially long strings into the task text.

### How It Works

1. Declare the input on the **receiving agent** in its frontmatter:

   ```yaml
   # .pi/flows/agents/developer.md
   inputs:
     - research_output
   ```

2. Wire the input in the **flow step** using a template expression:

   ```yaml
   ## developer
   agent: developer
   blockedBy: researcher
   inputs:
     research_output: "${{result.researcher.summary}}"
   ```

3. Reference it in the **agent's system prompt** as `${{input.research_output}}`:

   ```markdown
   You are a developer. Your task: ${{task}}

   Context from research:
   ${{input.research_output}}
   ```

### Complete Example

```yaml
name: research-and-build
description: Research the codebase then implement

steps:
  - id: researcher
    agent: researcher
    task: Investigate the codebase for ${{task}}

  - id: developer
    agent: developer
    blockedBy: [researcher]
    inputs:
      research_output: "${{result.researcher.summary}}"
    task: Implement based on research. Context is in ${{input.research_output}}.
```

### Typed Outputs

Agents can declare `outputs:` in their frontmatter to expose named values from their `finish` call to downstream steps:

```yaml
# agents/analyzer.md
outputs:
  - name: verdict
    description: Pass or fail determination
  - name: issues
    description: List of found issues
```

The agent calls `finish` with matching param names:

```
finish(summary="Done.", verdict="fail", issues="3 type errors found")
```

Downstream steps reference them as `${{result.STEP-ID.verdict}}`:

```yaml
## fixer
agent: fixer
blockedBy: analyzer
task: "Fix these issues (verdict: ${{result.analyzer.verdict}}): ${{result.analyzer.issues}}"
```

A simpler shorthand (without descriptions): `outputs: [verdict, issues]`

### Anti-Patterns

**❌ Inline everything into task** — This works but makes the task unwieldy for large outputs:

```yaml
  - id: developer
    agent: developer
    task: "Implement this: ${{result.researcher.summary}} ${{result.researcher.artifacts}}"
```

**✓ Use inputs for structured data** — Cleaner, more readable, and properly separated:

```yaml
  - id: developer
    agent: developer
    inputs:
      context: "${{result.researcher.summary}}"
      files_changed: "${{result.researcher.files}}"
    task: "Implement this feature. Context: ${{input.context}}. Consider files: ${{input.files_changed}}"
```

**❌ Referencing undeclared inputs** — If the agent's frontmatter doesn't list an input, `${{input.X}}` expands to an empty string:

```yaml
  # Developer agent has no `inputs:` declaration
  - id: developer-step
    agent: developer
    inputs:
      data: "some value"  # silently ignored in the system prompt
```

### File Content Injection (`file://` prefix)

When an agent needs the **content** of a file (not just a path string), use the `file://` prefix in the input value. The flow engine reads the file at dispatch time and injects its content directly into the agent's prompt.

**Static file path:**
```yaml
  - id: validate
    agent: validator
    blockedBy: [researcher]
    inputs:
      report: file://research/findings.md
```

**Dynamic file path from a previous step's output:**
```yaml
  - id: summarize
    agent: summarizer
    blockedBy: [writer]
    inputs:
      report: file://${{result.writer.files}}
```

**Rules:**
- The producing step **MUST** be listed in `blockedBy` so the file exists at dispatch time
- `${{result.STEP.files}}` contains comma-separated paths — use this pattern only when the step produces a single file
- File content is injected **verbatim** and never template-expanded, so files containing `${{}}` syntax are safe
- If the file does not exist at dispatch time, the step fails with a clear error

---

## Template Variable Reference

Use these placeholders in `task`, `inputs`, `question` fields in flow steps, and in agent system prompts:

| Variable | Resolves To |
|----------|-------------|
| `${{task}}` | The task passed when the flow was invoked |
| `${{result.<step-id>}}` | Full raw output from a completed step |
| `${{result.<step-id>.summary}}` | Summary text from a step's `finish` call |
| `${{result.<step-id>.status}}` | Status: `complete`, `error`, or `blocked` |
| `${{result.<step-id>.artifacts}}` | Structured data (XML) from a step's `finish` `artifacts` field |
| `${{result.<step-id>.files}}` | Comma-separated file paths created/modified by a step |
| `${{result.<step-id>.<outputName>}}` | A typed output value (from the agent's `outputs:` declaration) |
| `${{input.<name>}}` | A wired input value for this step (set in the `inputs:` block) |
| `${{loop.<step-id>.iteration}}` | Current iteration number in an agent-loop-decision step |
| `${{loop.<step-id>.max}}` | Maximum iterations configured for a loop step |

**Examples:**

```yaml
steps:
  - id: developer
    agent: developer
    task: "Implement feature: ${{task}}. Research: ${{result.researcher.summary}}"

  - id: verifier
    agent: verifier
    task: "Check iteration ${{loop.verify-loop.iteration}} of ${{loop.verify-loop.max}}: ${{result.developer.summary}}"
```

> **Fork context:** Fork decisions (question, answer, notes, who decided) are automatically injected into the branch step's system prompt. No `${{fork.*}}` wiring needed.

> **Resolution order:** Template variables are expanded just before an agent is dispatched, so `${{result.X}}` is only valid if step `X` ran before the current step (enforced by `blockedBy`). Referencing a step that hasn't completed yet resolves to an empty string.


---

## Dashboard

When a flow runs, a live dashboard appears above the editor showing all agents in a responsive grid. The grid layout auto-adjusts columns based on terminal width.

### Dashboard Controls

| Key | Action |
|-----|--------|
| **Ctrl+O** | Toggle navigation mode — use arrow keys to select cards |
| **Enter** | Open detail view for the selected card |
| **Ctrl+X** | Abort the running flow (global — works from any mode) |
| **Ctrl+A** | Toggle autonomous mode (global — works anytime, persisted across sessions) |
| **Esc** | Exit detail view or navigation mode |

When autonomous mode is active, `AUTO` appears in the footer bar. In this mode, fork steps that have an `agent:` field automatically select a branch without pausing to prompt the user — the named agent reads the flow context and calls `finish` with its choice. Fork steps without an `agent:` field continue to prompt the user even in autonomous mode.

### Agent Cards

Each card shows:
- **Agent name** and **step ID**
- **Status** — pending, running, complete, or error (color-coded)
- **Duration** and **token usage**
- **Metric line** — domain-specific data from a custom card renderer (e.g., file counts, test results)

### Detail View

Press Enter on a card to open the detail view:
- Full agent output (all assistant messages)
- Thinking traces (if enabled)
- Complete tool call history with inputs and outputs

### Summary Widget

After a flow completes, a summary widget appears above the editor showing final results per step. The summary is generated in two phases:

1. **Spinner** — a brief "Summarizing..." animation while the `@compact` model generates insight lines
2. **Summary box** — shows flow status, duration, agent count, and LLM-generated bullet points (falls back to per-agent status if no `@compact` model is available)

Summary controls:

| Key | Action |
|-----|--------|
| **Ctrl+O** | Enter navigate mode — browse agents with arrow keys |
| **Enter** | Open full detail view for the selected agent |
| **Backspace** | Return from navigate to summary mode |
| **Ctrl+X** | Dismiss the summary widget |

If a workflow pipeline is registered (via `flow:register-workflow`), the summary shows a "Next: /step-name" hint.

### Result Persistence

Flow results are automatically saved to `.pi/flows/results/`:

- **`<flow-name>.md`** — Human-readable markdown summary with insights, per-agent status, and files modified
- **`<flow-name>.json`** — Full structured `FlowResult` with all step outputs, tool calls, durations, and token counts

These files are overwritten on each run of the same flow name.

### The Main Session Stays Active

The main session remains fully interactive while the dashboard is active. You can type prompts, run bash commands, or use any other pi feature without interrupting the running flow.

---

## Flow Architect

The Flow Architect is an AI agent (`@planning` model with extended thinking) that designs flows interactively. It is spawned by `/flows:new` and `/flows:edit`.

### How It Works

1. **Context gathering** — The architect receives a structured summary of your main session conversation (generated by the `@compact` model), so it understands what you discussed before requesting the flow
2. **Staging** — All files are written to a staging directory (`.pi/flows/.staging/`) during design, not directly to the final location
3. **Replan loop** — After the architect produces a flow, you can choose:
   - **Save** — Promote staged files to `.pi/flows/` and register the flow as a command
   - **Replan** — Provide feedback and the architect redesigns from scratch
   - **Cancel** — Discard everything
4. **Run** — After save (or even without saving), you can execute the flow immediately

### Architect Widget

While the architect is working, a TUI widget shows progress:

| Key | Action |
|-----|--------|
| **Ctrl+O** | Preview the designed flow (DAG visualization) or view tool call history |
| **Ctrl+X** | Abort the architect agent |
| **↑↓ / Enter** | Navigate and inspect individual flows when multiple are produced |

### Architect Tools

The architect has access to specialized tools not available in the main session:

| Tool | Description |
|------|-------------|
| `agent_catalog` | Browse discovered agents with their descriptions, tools, and metadata |
| `agent_write` | Create or update agent `.md` files in the staging directory |
| `flow_write` | Create flow `.yaml` files with validation in the staging directory |
| `flow_preview` | Render a DAG preview of a flow for visual verification |
| `skill_read` | Read skill documentation files |

---

## Flow Context

Results from completed flows are persisted and accessible in the main session.

### `/flows` Action Menu

The `/flows` command provides a central management hub:

| Action | Description |
|--------|-------------|
| **New flow** | Describe what to build → spawns the Flow Architect |
| **List flows** | Show all saved flows and results |
| `/flows <name>` | Action menu for a specific flow: inject context, edit, or delete |

When you select a flow by name, you get:

| Action | Description |
|--------|-------------|
| **Inject context** | Send the flow result into the main session conversation |
| **Edit** | Open in the Flow Architect for modification |
| **Delete** | Remove the flow file, associated custom agents, and result files |

### `flow_results` Tool

The main session LLM can query past results programmatically:

| Action | Description |
|--------|-------------|
| `list` | List all available flow results with timestamps |
| `summary` | Per-step summary for a specific flow |
| `agent` | Full detail output for a specific step within a flow |

This is automatically available — you don't need to configure anything. The LLM calls it when it needs to reference previous flow work.

---

## Built-in Agents

pi-flows ships with three built-in agents:

| Agent | Model | Description |
|-------|-------|-------------|
| `flow-architect` | `@planning` (high thinking) | Designs custom execution flows from conversation context. Uses `agent_catalog`, `agent_write`, `flow_write`, `flow_preview`, `skill_read` tools. Only used internally by `/flows:new` and `/flows:edit`. |
| `flow-decision` | `@fast` | Makes autonomous decisions at fork and loop-decision points. Used when autonomous mode is active (Ctrl+A). Has no tools — purely a reasoning agent. |
| `project-context-reader` | `@coding` | Discovers and reads project planning files, documentation, and configuration. Available as a reusable agent in custom flows. |

Project-local agents in `.pi/flows/agents/` override built-in agents with the same name.

---

## Footer Bar

pi-flows replaces the default footer with a composable status bar showing:

| Segment | Description |
|---------|-------------|
| **Provider · Model** | Current session provider and model display name |
| **⎇ branch** | Current git branch (refreshed after flow completion) |
| **File stats** | Files modified in the session with `+insertions` / `-deletions` |
| **Context bar** | Visual bar showing context window usage percentage (green → yellow → red) |
| **AUTO** | Shown when autonomous mode is active (toggles with Ctrl+A) |
| **Extension segments** | Custom segments registered by domain packages via `flow:register-footer-segment` |

Segments are separated by `│` dividers. The footer updates after each LLM turn and file modification.

---

## Extending pi-flows

Domain packages can register additional agents, flows, skills, and UI elements by emitting events from their extension's `activate` function:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function activate(pi: ExtensionAPI) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // Register agents, flows, and skills
  pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
  pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
  pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });
}
```

### Registration Events

| Event | Purpose |
|-------|---------|
| `flow:register-agents-dir` | Add a directory of agent `.md` files |
| `flow:register-flows-dir` | Add a directory of `.yaml` files (registered as commands) |
| `flow:unregister-agents-dir` | Remove a previously registered agents directory |
| `flow:unregister-flows-dir` | Remove a previously registered flows directory |
| `flow:register-skills-dir` | Add a skills directory |
| `flow:register-card` | Register a custom dashboard card metric renderer |
| `flow:register-workflow` | Register a multi-stage workflow for dashboard breadcrumbs |
| `flow:register-gate` | Add a prerequisite check that must pass before flows run |
| `flow:register-guard-extension` | Register an additional sandboxing guard for spawned agents |
| `flow:register-footer-segment` | Add a segment to the footer status bar |
| `flow:register-tool` | Register a custom tool available to agents that declare it in `tools:` |

### Listening to Flow Events

| Event | Fired When |
|-------|-----------|
| `flow:complete` | A flow finishes — receives the full `FlowResult` with all step results |
| `flow:subagent-tool-call` | An agent calls a tool — `{ agentName, toolName, input }` |
| `flow:subagent-tool-result` | A tool returns — `{ agentName, toolName, output, isError }` |
| `flow:auto-decision` | A fork step auto-decides in autonomous mode — `{ forkId, agentName, chosenBranch, targetStepId }` |
| `flow:loop-iteration` | A loop step advances — `{ stepId, iteration, maxIterations, loopTarget }` |

### Programmatic Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `flow:run` | Emit | Trigger a flow by name: `{ flowName: string }` |
| `flow:rediscover` | Emit | Re-scan all agent and flow directories, register new commands |
| `flow:get-agents` | Emit | Query discovered agents: emitter sets `data.agents` to the agent `Map` |
| `flow:get-spawn-context` | Emit | Get auth, model registry, guard factories, and extension tools for spawning agents |

### Discovery Priority

When multiple sources define an agent or flow with the same name, later registrations win:

1. Extra package agents (registered via `flow:register-agents-dir`)
2. pi-flows built-in agents
3. Project-local agents (`.pi/flows/agents/`) — **highest priority**

This allows project-local files to override any package defaults.

---

## Provider Management

The `/provider` command manages LLM provider connections. Providers are OpenAI-compatible or Anthropic-compatible API endpoints.

### Adding a Provider

```
/provider
→ + Add new provider
  Name: my-proxy
  Base URL: https://my-proxy.example.com/v1
  API Key: $MY_PROXY_KEY  (or literal key)
  Protocol: openai-completions | anthropic-messages
  Models: (multi-select from catalog)
```

API keys can be:
- **Environment variable reference** — `$ENV_VAR_NAME` (resolved at runtime)
- **Literal value** — stored directly (automatically set as a synthetic env var)

### Editing a Provider

Select an existing provider from the list to edit its base URL, API key, protocol, or model selection.

### Model Selection

When adding or editing a provider, you can restrict which catalog models are available through it. The multi-select overlay supports:
- **Toggle individual models** with Space/Enter
- **Toggle all** for quick select/deselect
- **Quick-add** (`+ Add new model`) to add a model to the catalog inline

If no models are selected (or all are), the provider exposes all catalog models.

> **Config location:** All provider, role, preset, catalog, and autonomous mode settings are stored in `~/.pi/agent/providers.json`.

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.58.4+
- Node.js 20.6+

---

## Developer Docs

For building packages on top of pi-flows, see the detailed reference documentation:

### Guides

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview, component stack, package discovery, agent isolation model, flow execution model |
| [Creating Packages](docs/creating-packages.md) | Step-by-step guide to building a custom pi-flows package from scratch |
| [Extending pi-flows](docs/extending-pi-flows.md) | Complete guide for building packages on pi-flows: registration patterns, custom cards, workflows, gates, guards, footer segments |

### References

| Document | Description |
|----------|-------------|
| [Agent Reference](docs/agents.md) | Agent definition format, frontmatter schema, model tiers, card types, design principles, and examples |
| [Flow Reference](docs/flows.md) | All flow step types (agent, fork, conditional, loop, flow-ref), result interpolation, and common patterns |
| [Skills & Extensions](docs/skills-and-extensions.md) | Skill directory format, SKILL.md authoring, extension API, guard patterns |
| [Events API](docs/events-api.md) | All `flow:*` events with data shapes, direction (emit vs listen), and code examples |
| [Tools Reference](docs/tools-reference.md) | All tools by execution context — main session, agent session, architect session |
| [Flow Authoring](docs/flow-authoring.md) | Detailed agent and flow file format reference with all fields and examples |
| [Public API](docs/public-api.md) | Exported types and functions: `AgentConfig`, `FlowConfig`, `spawnAgent`, `runFlow`, `discoverAll`, etc. |

---

## License

MIT
