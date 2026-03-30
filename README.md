# pi-flows

A [pi-package](https://github.com/badlogic/pi-mono) that adds multi-agent workflow orchestration to pi. Design flows as markdown files, run them with automatic parallel scheduling, and watch everything in a live dashboard — while the main session stays fully interactive.

## Table of Contents

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
  - [Model Catalog](#model-catalog)
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
- [Flow Context](#flow-context)
- [Extending pi-flows](#extending-pi-flows)
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
/catalog           Browse or add custom models to the catalog (optional)
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

```markdown
---
name: my-research
description: Run a research pass on the codebase
---

## researcher
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
| `/catalog` | Browse, add, edit, or delete models in the model catalog |
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
| `context` | | File paths (relative to project root) injected as read-only context |
| `inputs` | | Named inputs this agent expects — declared as a contract for flow wiring |
| `output` | | Default output filename |
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

### Model Catalog

The **model catalog** is the library of models available for role assignment. It is stored globally at `~/.pi/agent/providers.json` and pre-populated with common models. Use `/catalog` to manage it:

```
/catalog
```

The catalog overlay opens with a searchable list of all known models. From here you can:

| Action | How |
|--------|-----|
| **Browse** | Scroll or type to filter — each entry shows the model ID, display name, and capability tags (`reasoning`, `vision`, context window size) |
| **Add** | Select `+ Add new model`, enter the provider-prefixed model ID (e.g., `openai/gpt-5`) |
| **Edit** | Select any model to open its settings — change display name, toggle reasoning/vision support, adjust context window and max tokens |
| **Delete** | Open a model's edit screen and choose `Delete → confirm` |

New models added via `/catalog` immediately appear in the `/roles` model selector. This is useful when your LLM provider offers models not yet in the default catalog.

**Example: adding a custom OpenAI model**

```
/catalog
→ + Add new model
  Model ID: openai/gpt-5-mini
→ saved to catalog

/roles
→ @fast → openai/gpt-5-mini
```

> **Config location:** All catalog changes are persisted to `~/.pi/agent/providers.json` alongside your provider credentials and role assignments.

### Access Control

The `access` block restricts what an agent can read, write, and run. This sandboxes agents to prevent accidental damage:

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
| `max_concurrent` | | Maximum agents running in parallel (default: unlimited) |
| `task_required` | | When `true`, prompts the user for a task if none was provided with the command |
| `task_prompt` | | Custom prompt text shown when asking for a task |

> **Command name = file path, not `name:` field.** The slash command for a flow is determined by its position in the flows directory, not the `name:` frontmatter value:
>
> | File path | Registered command |
> |-----------|-------------------|
> | `.pi/flows/flows/research.yaml` | `/research` |
> | `.pi/flows/flows/judo/research.yaml` | `/judo:research` |
>
> Subdirectories add a colon-separated prefix (max one level deep). Keep the frontmatter `name:` in sync for clarity, but know that pi-flows always uses the filesystem-derived name.

### Agent Steps

The default step type. Dispatches a named agent with a task. The `##` header text is the **step ID**. The `agent:` field is **always required** — it specifies which agent to dispatch.

```yaml
## researcher
agent: researcher
task: Investigate the codebase for ${{task}}
```

When the same agent needs to run multiple times in a flow with different tasks, give each step a unique ID:

```yaml
## create-draft
agent: writer
task: Write the initial draft

## revise-draft
agent: writer
task: Revise the draft based on feedback
```

Wire dependencies and result references using the **step ID** (`blockedBy: create-draft`, `${{result.create-draft.summary}}`), not the agent name.

**All agent step fields:**

| Field | Description |
|-------|-------------|
| `agent` | **Required.** Agent name to dispatch |
| `task` | Task override (template string). If omitted, uses the flow's task |
| `model` | Model override for this step only |
| `blockedBy` | Step IDs (comma-separated) that must complete before this step starts |
| `inputs` | Named inputs wired from template expressions (see [Input Wiring](#input-wiring)) |
| `output` | Output filename override |
| `reads` | File paths to inject as context before execution |
| `on_complete` | Step ID to route to on success |
| `on_error` | Step ID to route to on error |

### Fork Steps

Pause execution and ask the user a question, then branch based on their answer. Fork steps use the `## fork: id` header syntax.

```
## fork: choose-approach
question: Which approach do you prefer?
options: Quick fix, Full refactor
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
| `allowNotes` | Prompt for optional freetext notes after selection. Access via `${{fork.ID.notes}}` |
| `allowCustom` | Add an "Other (describe)" option. Freetext answers are handled by a decision agent |
| `multiSelect` | Allow selecting multiple options. All selected branches execute sequentially |
| `agent` | Agent name for autonomous mode. When `🤖 auto` is active (Ctrl+A), this agent decides the branch automatically instead of prompting the user |
| `task` | Task description for the autonomous agent. Defaults to a prompt containing the question and options if omitted |

The user's answer is available in downstream steps as `${{fork.choose-approach.answer}}` and notes as `${{fork.choose-approach.notes}}`.

> **`options:` format:** Options can be comma-separated inline (`options: fast, thorough`) or as a YAML list. Option text must exactly match the keys in `branches:`.

### Conditional Steps

Branch based on whether a field from a previous step's result is non-empty. Conditional steps use the `## conditional: id` header syntax.

```
## conditional: check-research
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

Delegate a routing decision to an agent. The agent analyzes the situation and calls `finish` with a `branch` name. Agent decision steps use the `## agent-decision: id` header syntax.

```
## agent-decision: route-decision
agent: router-agent
task: "Review the analysis and decide what to do next: ${{result.analyzer.summary}}"
branches:
  needs-work: fix-step
  ready: deploy-step
```

The decision agent must call `finish` with `branch: "needs-work"` or `branch: "ready"`. Any other branch name causes an error.

### Agent Loop Decision Steps

Iterative verify/fix cycles. The agent decides on each iteration whether to loop back or exit forward. Loop decision steps use the `## agent-loop-decision: id` header syntax.

```
## agent-loop-decision: verify-loop
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

Delegate execution to another flow file. The path to the sub-flow is encoded directly in the header using the `## flow-ref: path` syntax.

```
## flow-ref: .pi/flows/flows/test-suite.yaml
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

```markdown
---
name: research-and-build
description: Research the codebase then implement
---

## researcher
agent: researcher
task: Investigate the codebase for ${{task}}

## developer
agent: developer
blockedBy: researcher
inputs:
  research_output: "${{result.researcher.summary}}"
task: Implement based on research. Context is in ${{input.research_output}}.
```

### Anti-Patterns

**❌ Inline everything into task** — This works but makes the task unwieldy for large outputs:

```yaml
## developer
agent: developer
task: "Implement this: ${{result.researcher.summary}} ${{result.researcher.artifacts}}"
```

**✓ Use inputs for structured data** — Cleaner, more readable, and properly separated:

```yaml
## developer
agent: developer
inputs:
  context: "${{result.researcher.summary}}"
  files_changed: "${{result.researcher.files}}"
task: "Implement this feature. Context: ${{input.context}}. Consider files: ${{input.files_changed}}"
```

**❌ Referencing undeclared inputs** — If the agent's frontmatter doesn't list an input, `${{input.X}}` expands to an empty string:

```yaml
# Developer agent has no `inputs:` declaration
## developer-step
agent: developer
inputs:
  data: "some value"  # silently ignored in the system prompt
```

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
| `${{result.<step-id>.files}}` | Files touched by a step, e.g. `src/auth.ts (created), ...` |
| `${{input.<name>}}` | A wired input value for this step (set in the `inputs:` block) |
| `${{fork.<step-id>.answer}}` | The user's answer from a fork step |
| `${{fork.<step-id>.notes}}` | Optional notes the user added to a fork answer |
| `${{loop.<step-id>.iteration}}` | Current iteration number in an agent-loop-decision step |
| `${{loop.<step-id>.max}}` | Maximum iterations configured for a loop step |

**Examples:**

```yaml
## developer
agent: developer
task: "Implement feature: ${{task}}. Research: ${{result.researcher.summary}}"

## verifier
agent: verifier
task: "Check iteration ${{loop.verify-loop.iteration}} of ${{loop.verify-loop.max}}: ${{result.developer.summary}}"

## post-fork
agent: writer
task: "User chose: ${{fork.choose-approach.answer}}. Notes: ${{fork.choose-approach.notes}}"
```

> **Resolution order:** Template variables are expanded just before an agent is dispatched, so `${{result.X}}` is only valid if step `X` ran before the current step (enforced by `blockedBy`). Referencing a step that hasn't completed yet resolves to an empty string.

> **Legacy syntax:** The `{variable}` form (without the `${{...}}` wrapper) is still accepted for backward compatibility but is deprecated. Use `${{variable}}` in all new flows and agents.

---

## Dashboard

When a flow runs, a live dashboard appears above the editor showing all agents in a responsive grid.

### Dashboard Controls

| Key | Action |
|-----|--------|
| **Ctrl+O** | Toggle navigation mode — use arrow keys to select cards |
| **Enter** | Open detail view for the selected card |
| **Ctrl+X** | Abort the running flow |
| **Ctrl+A** | Toggle autonomous mode — fork steps auto-decide via their declared agent (see [Fork Steps](#fork-steps)) |
| **Esc** | Exit detail view or navigation mode |

When autonomous mode is active, `🤖 auto` appears in the footer bar. In this mode, fork steps that have an `agent:` field automatically select a branch without pausing to prompt the user — the named agent reads the flow context and calls `finish` with its choice. Fork steps without an `agent:` field continue to prompt the user even in autonomous mode.

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

After a flow completes, a summary widget appears below the dashboard showing final results per step. Press Enter on any step to expand its full output. If a workflow pipeline is registered (via `flow:register-workflow`), breadcrumb navigation shows which stage just completed.

### The Main Session Stays Active

The main session remains fully interactive while the dashboard is active. You can type prompts, run bash commands, or use any other pi feature without interrupting the running flow.

---

## Flow Context

Results from completed flows are persisted and accessible in the main session.

### Inline Reference (`#flows:<name>`)

Type `#flows:` in the editor to see a list of flows with saved results. Selecting one inlines the result summary into your message, so the main session LLM can reason about it.

### `flow_results` Tool

The main session LLM can query past results programmatically:

| Action | Description |
|--------|-------------|
| `list` | List all available flow results with timestamps |
| `summary` | Per-step summary for a specific flow |
| `agent` | Full detail output for a specific step within a flow |

This is automatically available — you don't need to configure anything. The LLM calls it when it needs to reference previous flow work.

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
| `flow:auto-decision` | A fork step auto-decides in autonomous mode |
| `flow:loop-iteration` | A loop step advances — `{ stepId, iteration, maxIterations }` |

### Discovery Priority

When multiple sources define an agent or flow with the same name, later registrations win:

1. Extra package agents (registered via `flow:register-agents-dir`)
2. pi-flows built-in agents
3. Project-local agents (`.pi/flows/agents/`) — **highest priority**

This allows project-local files to override any package defaults.

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.58.4+
- Node.js 20.6+

---

## Developer Docs

For building packages on top of pi-flows, see the detailed reference documentation:

| Document | Description |
|----------|-------------|
| [Extending pi-flows](docs/extending-pi-flows.md) | Complete guide for building packages on pi-flows: package setup, registration patterns, custom cards, workflows, gates, guards, footer segments |
| [Events API](docs/events-api.md) | All `flow:*` events with data shapes, direction (emit vs listen), and code examples — including `flow:register-tool` for custom agent tools |
| [Tools Reference](docs/tools-reference.md) | All tools by execution context — main session, agent session, architect session |
| [Flow Authoring](docs/flow-authoring.md) | Detailed agent and flow file format reference with all fields and examples |
| [Public API](docs/public-api.md) | Exported types and functions: `AgentConfig`, `FlowConfig`, `spawnAgent`, `runFlow`, `discoverAll`, etc. |

---

## License

MIT
