# Flow Authoring

Comprehensive reference for writing agents (`.md` files) and flows (`.flow.md` files). For a quick start, see the main [README](../README.md).

## Table of Contents

- [Writing Agents](#writing-agents)
  - [Agent Frontmatter Reference](#agent-frontmatter-reference)
  - [Available Agent Tools](#available-agent-tools)
  - [Model Roles](#model-roles)
  - [Access Control](#access-control)
  - [Agent Example](#agent-example)
- [Writing Flows](#writing-flows)
  - [Flow Frontmatter](#flow-frontmatter)
  - [Step Types](#step-types)
  - [Template Variables](#template-variables)
  - [Flow Example](#flow-example)

---

## Writing Agents

Agents are `.md` files with YAML frontmatter and a system prompt body. Place them in `.pi/flows/agents/` or a registered agents directory (via `flow:register-agents-dir`).

### Agent Frontmatter Reference

| Field | Required | Type | Description | Example |
|-------|:---:|------|-------------|---------|
| `name` | yes | `string` | Unique agent identifier | `researcher` |
| `description` | yes | `string` | What this agent does | `Investigates the codebase` |
| `model` | yes | `string` | Model role (`@coding`, `@planning`) or direct model ID | `@coding` |
| `thinking` | no | `string` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | `high` |
| `tools` | yes | `string` | Comma-separated list of tools | `read, write, edit, bash` |
| `skills` | no | `string \| string[]` | Skill names to inject into system prompt | `judo-backend-docs` |
| `context` | no | `string[]` | File paths to inject as context (resolved relative to project root) | `["src/config.ts"]` |
| `inputs` | no | `string[]` | Named inputs this agent expects (populated via step `inputs:`) | `["research_output"]` |
| `output` | no | `string` | Default output filename | `report.md` |
| `interactive` | no | `boolean` | Whether this agent interacts with the user | `false` |
| `access` | no | `AccessRules` | Sandboxing rules (see [Access Control](#access-control)) | — |
| `card` | no | `CardConfig` | Dashboard card configuration (see below) | — |
| `architect` | no | `ArchitectMeta` | Hints for the Flow Architect (see below) | — |

#### card (Dashboard Card Config)

| Sub-field | Type | Description | Example |
|-----------|------|-------------|---------|
| `card.label` | `string` | Display label on the dashboard card | `"Research"` |
| `card.metric` | `string` | Metric renderer name (built-in: `default`, `files`, `tests`) | `"files"` |
| `card.type` | `string` | Card type hint | `"agent"` |
| `card.role` | `string` | Visual role hint | `"primary"` |

Custom metric renderers are registered via `flow:register-card`. See [events-api.md](events-api.md#flowregister-card).

#### architect (Flow Architect Metadata)

| Sub-field | Type | Description | Example |
|-----------|------|-------------|---------|
| `architect.use_when` | `string` | When the architect should select this agent | `"When code changes are needed"` |
| `architect.produces` | `string` | What this agent outputs | `"Modified source files"` |
| `architect.depends_on` | `string` | What inputs this agent needs | `"Research results"` |
| `architect.domain` | `string` | Domain classification | `"development"` |

### Available Agent Tools

These tools can be declared in the agent `tools:` field:

| Tool | Description |
|------|-------------|
| `read` | Read file contents (text and images) |
| `write` | Write/create files |
| `edit` | Surgical text replacement |
| `bash` | Execute shell commands |
| `grep` | Search file contents |
| `glob` | Find files by pattern |
| `find` | Find files in directory trees |
| `ls` | List directory contents |
| `skill_read` | Read skill documentation files |

> **Note:** The `finish` tool is automatically available to every agent — do **not** declare it. Agents must call `finish` as their last action to submit structured results. See [tools-reference.md](tools-reference.md#finish) for the `finish` parameter schema.

### Model Roles

Agents reference models using role aliases prefixed with `@`. Roles are assigned to specific models via the `/roles` command.

| Role | Typical Use |
|------|-------------|
| `@planning` | High-level reasoning, architecture, decision-making |
| `@coding` | Code generation and modification |
| `@fast` | Quick tasks, routing decisions |
| `@research` | Investigation and analysis |
| `@compact` | Summarization |
| `@vision` | Image/visual analysis |

**Setup:**

```
/roles             # Interactive role assignment UI
/provider          # Add an LLM provider first
```

**Resolution:** When an agent specifies `model: @coding`, the flow engine resolves `@coding` to whatever concrete model the user has assigned to that role. If a model reference includes a thinking suffix (e.g., `claude-sonnet-4-20250514:high`), the suffix is used as the thinking level unless the agent's `thinking` field overrides it.

### Access Control

The `access` frontmatter block restricts what an agent can do, providing sandboxing for sensitive operations.

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
      - "sudo *"
      - "curl *"
```

| Sub-field | Type | Description |
|-----------|------|-------------|
| `access.read` | `string[]` | Glob patterns for allowed read paths. If set, reads outside these patterns are blocked. |
| `access.write` | `string[]` | Glob patterns for allowed write paths. If set, writes outside these patterns are blocked. |
| `access.bash.deny` | `string[]` | Command patterns to block. Matched against the `command` argument of bash tool calls. |

### Agent Example

```markdown
---
name: backend-developer
description: Implements backend changes based on research findings
model: @coding
thinking: high
tools: read, write, edit, bash, grep
skills: judo-backend-docs
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

You are a backend developer. Your task: {task}

Use the research context provided:
{input.research_output}

Focus on clean, tested implementations. Run existing tests after changes.
```

---

## Writing Flows

Flows are `.flow.md` files with YAML frontmatter and `##`-delimited steps. Save them in `.pi/flows/flows/` or a registered flows directory (via `flow:register-flows-dir`). Each saved flow auto-registers as a `/command`.

### Flow Frontmatter

| Field | Required | Type | Description |
|-------|:---:|------|-------------|
| `name` | yes | `string` | Flow identifier (becomes the slash command) |
| `description` | yes | `string` | What this flow does |
| `max_concurrent` | no | `number` | Maximum agents running in parallel (default: unlimited) |

### Step Types

Each `## heading` defines a step. The step's `id` defaults to the heading text. Steps are executed based on their dependencies (`blockedBy`).

#### agent

Dispatch a named agent to perform a task.

| Field | Required | Description |
|-------|:---:|-------------|
| `agent` | no | Agent name (defaults to step id) |
| `task` | no | Task override (template string) |
| `model` | no | Model override for this step |
| `blockedBy` | no | Step IDs that must complete first (comma-separated or array) |
| `inputs` | no | Named inputs wired from template expressions |
| `output` | no | Output file |
| `reads` | no | Files to read before execution |
| `on_complete` | no | Step ID to route to on success |
| `on_error` | no | Step ID to route to on error |

```yaml
## developer
agent: backend-developer
blockedBy: researcher
inputs:
  research_output: "{result.researcher.summary}"
task: Implement based on research: {input.research_output}
```

#### fork

Ask the user a question and branch based on their answer.

| Field | Required | Description |
|-------|:---:|-------------|
| `stepType` | yes | `fork` |
| `question` | yes | Question to display |
| `options` | yes | Answer choices |
| `branches` | yes | Map of option → step ID |
| `allowNotes` | no | Prompt for optional notes |
| `allowCustom` | no | Add "Other (describe)" option |
| `multiSelect` | no | Allow multiple selections |

```yaml
## choose-approach
stepType: fork
question: "Which approach do you prefer?"
options:
  - Quick fix
  - Full refactor
branches:
  Quick fix: quick-fix-step
  Full refactor: refactor-step
```

#### conditional

Branch based on the presence of data in a previous step's result.

| Field | Required | Description |
|-------|:---:|-------------|
| `stepType` | yes | `conditional` |
| `check` | yes | Dot-path to check in artifacts (e.g., `"test-runner.status"`) |
| `present` | yes | Step ID if the checked value exists |
| `absent` | yes | Step ID if the checked value is missing |

```yaml
## check-gaps
stepType: conditional
check: researcher.artifacts.gaps
present: fix-gaps-step
absent: proceed-step
```

#### agent-decision

Let an agent analyze results and choose a branch.

| Field | Required | Description |
|-------|:---:|-------------|
| `stepType` | yes | `agent-decision` |
| `agent` | yes | Agent name for the decision |
| `task` | yes | Task for the decision agent (template string) |
| `branches` | yes | Map of branch name → step ID |

```yaml
## route-decision
stepType: agent-decision
agent: my-router
task: "Analyze results and decide: {result.analyzer.summary}"
branches:
  needs-work: fix-step
  ready: deploy-step
```

The decision agent must call `finish` with a `branch` parameter matching one of the declared branch names.

#### agent-loop-decision

Iterative verify/fix cycles. An agent decides whether to loop back or exit forward.

| Field | Required | Description |
|-------|:---:|-------------|
| `stepType` | yes | `agent-loop-decision` |
| `agent` | yes | Agent name for the loop decision |
| `task` | yes | Task for the decision agent (template string) |
| `loop_target` | yes | Step ID to jump back to |
| `exit_target` | yes | Step ID to continue to |
| `max_iterations` | yes | Safety cap (forces exit when exceeded) |

```yaml
## verify-loop
stepType: agent-loop-decision
agent: verifier
task: "Check implementation: {result.developer.summary}"
loop_target: developer
exit_target: finalize
max_iterations: 3
```

The verifier agent calls `finish` with `branch: "<loop_target>"` to loop back, or `branch: "<exit_target>"` to proceed.

#### flow-ref

Delegate execution to a sub-flow.

| Field | Required | Description |
|-------|:---:|-------------|
| `stepType` | yes | `flow-ref` |
| `path` | yes | Path or glob to flow file(s) |
| `on_complete` | no | Step ID to route to on success |
| `on_error` | no | Step ID to route to on error |

```yaml
## run-tests
stepType: flow-ref
path: .pi/flows/flows/test-suite.flow.md
```

### Template Variables

Use these in `task`, `inputs`, and `question` fields:

| Variable | Resolves To |
|----------|-------------|
| `{task}` | The task passed when the flow was invoked |
| `{result.<step-id>.summary}` | Summary from a completed step's `finish` call |
| `{result.<step-id>.status}` | Status: `complete`, `error`, `blocked` |
| `{result.<step-id>.artifacts}` | Structured data (XML) from a step's `finish` call |
| `{result.<step-id>.files}` | Files touched by a step |
| `{result.<step-id>}` | Full output from a step |
| `{input.<name>}` | Resolved step input value (wired in `inputs:` block) |
| `{fork.<id>.answer}` | User's answer from a fork step |
| `{fork.<id>.notes}` | User's notes from a fork step |
| `{loop.<id>.iteration}` | Current loop iteration number |
| `{loop.<id>.max}` | Max iterations for a loop |

### Flow Example

```markdown
---
name: research-and-build
description: Research the codebase then implement changes
max_concurrent: 2
---

## researcher
task: Investigate the codebase for {task}

## developer
blockedBy: researcher
inputs:
  context: "{result.researcher.summary}"
task: Implement based on research context: {input.context}

## verify-loop
stepType: agent-loop-decision
agent: verifier
task: "Check if implementation is correct: {result.developer.summary}"
loop_target: developer
exit_target: finalize
max_iterations: 3

## finalize
blockedBy: verify-loop
task: Write documentation for the changes made
```
