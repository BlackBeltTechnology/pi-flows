# pi-flows

A [pi-package](https://github.com/badlogic/pi-mono) that adds multi-agent workflow orchestration to pi. Design flows as markdown, run them with parallel scheduling, and monitor everything in a live dashboard.

## Install

Global (available in all projects):

```bash
pi install git:github.com/BlackBeltTechnology/pi-flows
```

Local (project-only, saved to `.pi/settings.json`):

```bash
pi install -l git:github.com/BlackBeltTechnology/pi-flows
```

## Quick Start

1. **Set up providers and roles** — assign models to roles so agents know which model to use:
   ```
   /provider          Add an LLM provider
   /roles             Assign models to roles (@planning, @coding, @fast, etc.)
   ```

2. **Create a flow** — use the interactive designer or write one by hand:
   ```
   /flows:new         Design a new flow with the Flow Architect
   ```

3. **Run a flow** — every saved flow registers as a `/command`:
   ```
   /my-flow           Run the flow (use the name from the flow file)
   ```

4. **Work while it runs** — the main session stays fully interactive. Type prompts, run bash commands, or use other extensions while the flow runs in the background.

## Commands

| Command | Description |
|---------|-------------|
| `/flows` | Action menu — create, list, edit, or delete flows |
| `/flows:new` | Design and run a new flow interactively |
| `/flows:edit` | Modify an existing saved flow |
| `/flows:delete` | Remove a flow and its results |
| `/provider` | Add, list, or remove LLM providers |
| `/roles` | Assign models to named roles |
| `/<flow-name>` | Run a saved flow (auto-registered from `.pi/flows/`) |

## Dashboard

When a flow runs, a live dashboard appears above the editor:

- **Agent cards** show status, duration, tokens, and domain-specific metrics in a responsive grid
- **Ctrl+O** toggles navigation mode — use arrow keys to select a card, Enter to open the detail view
- **Ctrl+X** aborts the running flow
- **Detail view** shows full agent output, thinking traces, and tool call history
- **Summary widget** appears after completion with final results per agent

The main session remains usable while the dashboard is active. You can send prompts, run bash commands, or use any other pi feature.

## Writing Flows

Flows are `.flow.md` files with YAML frontmatter and `##`-delimited steps. Save them in `.pi/flows/flows/` to auto-register as commands.

### Basic Flow

```markdown
---
name: research-and-build
description: Research the codebase then implement
max_concurrent: 2
---

## researcher
task: Investigate the codebase for {task}

## developer
blockedBy: researcher
inputs:
  context: "{result.researcher.summary}"
task: Implement based on research context: {input.context}
```

### Step Types

**Agent step** — dispatch a named agent:
```markdown
## my-step
agent: my-agent          # optional if step name matches agent name
task: Do the thing for {task}
blockedBy: other-step    # wait for dependency
inputs:
  data: "{result.other-step.artifacts}"
```

**Fork** — ask the user a question and branch:
```markdown
## choose-approach
stepType: fork
question: "Which approach?"
options:
  - Quick fix
  - Full refactor
branches:
  Quick fix: quick-fix-step
  Full refactor: refactor-step
```

**Conditional** — branch based on previous results:
```markdown
## check-tests
stepType: conditional
check: test-runner.status
present: deploy-step
absent: fix-step
```

**Agent decision** — let an agent choose the branch:
```markdown
## route-decision
stepType: agent-decision
agent: my-router
task: "Analyze results and decide: {result.analyzer.summary}"
branches:
  needs-work: fix-step
  ready: deploy-step
```

**Loop decision** — iterative verify/fix cycles:
```markdown
## verify-loop
stepType: agent-loop-decision
agent: my-verifier
task: "Check if the implementation is correct: {result.developer.summary}"
loop_target: developer
exit_target: finalize
max_iterations: 3
```

**Flow ref** — delegate to sub-flows:
```markdown
## run-sub
stepType: flow-ref
path: .pi/flows/flows/sub-flow.flow.md
```

### Template Variables

Use these in `task`, `inputs`, and `question` fields:

| Variable | Resolves To |
|----------|-------------|
| `{task}` | The task passed when the flow was invoked |
| `{result.<step-id>.summary}` | Summary from a completed step |
| `{result.<step-id>.status}` | Status: `complete`, `error`, `blocked` |
| `{result.<step-id>.artifacts}` | Structured data from a step |
| `{result.<step-id>.files}` | Files touched by a step |
| `{result.<step-id>}` | Full output from a step |
| `{input.<name>}` | Resolved step input value |
| `{fork.<id>.answer}` | User's answer from a fork step |
| `{fork.<id>.notes}` | User's notes from a fork step |
| `{loop.<id>.iteration}` | Current loop iteration number |
| `{loop.<id>.max}` | Max iterations for a loop |


## Writing Agents

Agents are `.md` files with YAML frontmatter and a system prompt body. Place them in `.pi/flows/agents/` or a registered agents directory.

```markdown
---
name: my-agent
description: What this agent does
model: @coding
thinking: high
tools: read, write, edit, bash, grep
skills: my-docs
inputs:
  - research_output
card:
  label: "My Agent"
  metric: "files"
architect:
  use_when: "When the task requires code changes"
  produces: "Modified source files"
  depends_on: "research results"
  domain: "development"
---

You are a specialized agent. Your task: {task}

Use the research context: {input.research_output}
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique agent identifier |
| `description` | yes | What this agent does |
| `model` | yes | Model role (`@coding`, `@planning`, `@fast`, etc.) or direct model ID |
| `thinking` | no | Thinking level: `high`, `medium`, `low` |
| `tools` | yes | Comma-separated tool list |
| `skills` | no | Skills to inject into the system prompt |
| `inputs` | no | Named inputs this agent expects (populated via step `inputs:`) |
| `context` | no | File paths to inject as context |
| `access` | no | Sandboxing rules for read/write/bash |
| `card` | no | Dashboard card config: `label`, `metric`, `type`, `role` |
| `architect` | no | Hints for the Flow Architect: `use_when`, `produces`, `depends_on`, `domain` |

### Available Tools

These tools can be declared in the agent `tools:` field:

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `write` | Write/create files |
| `edit` | Surgical text replacement |
| `bash` | Execute shell commands |
| `grep` | Search file contents |
| `glob` | Find files by pattern |
| `find` | Find files in directory trees |
| `ls` | List directory contents |
| `skill_read` | Read skill documentation files |
| `model_cli` | Query and modify `.model` files |
| `model_cli_readonly` | Read-only `.model` file access |

The `finish` tool is automatically available to every agent — do not declare it. Agents must call `finish` as their last action to submit structured results.

### Model Roles

Assign models to roles with `/roles`. Agents reference roles with `@` prefix:

| Role | Typical Use |
|------|-------------|
| `@planning` | High-level reasoning, architecture, decision-making |
| `@coding` | Code generation and modification |
| `@fast` | Quick tasks, routing decisions |
| `@research` | Investigation and analysis |
| `@compact` | Summarization |
| `@vision` | Image/visual analysis |
| `@modelling` | Domain-specific modelling |

## Flow Context

Access results from completed flows in the main session:

- **`#flows:<name>`** — type in the editor to inline a flow's result summary
- **`flow_results` tool** — the main session LLM can query past flow results

## Extending pi-flows

Domain packages can register additional agents, flows, skills, dashboard cards, and footer segments:

| Event | Purpose |
|-------|---------|
| `flow:register-agents-dir` | Add a directory of agent `.md` files |
| `flow:register-flows-dir` | Add a directory of flow `.flow.md` files |
| `flow:register-skills-dir` | Add a skills directory |
| `flow:register-card` | Register a custom dashboard card renderer |
| `flow:register-workflow` | Register a multi-stage workflow for the dashboard |
| `flow:register-gate` | Add a prerequisite check before flows can run |
| `flow:register-footer-segment` | Add a segment to the footer bar |
| `flow:run` | Programmatically trigger a flow by name |
| `flow:complete` | Listen for flow completion (receives full results) |

See the [detailed documentation](docs/) for the full API reference:

| Document | Description |
|----------|-------------|
| [Extending pi-flows](docs/extending-pi-flows.md) | Complete guide for building packages on top of pi-flows |
| [Events API](docs/events-api.md) | All `flow:*` events with data shapes and examples |
| [Tools Reference](docs/tools-reference.md) | All registered tools by execution context |
| [Flow Authoring](docs/flow-authoring.md) | Agent and flow file format reference |
| [Public API](docs/public-api.md) | Exported types and functions |

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.58.4+
- Node.js 20.6+

## License

MIT
