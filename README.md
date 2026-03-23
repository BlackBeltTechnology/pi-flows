# pi-flows

A [pi-package](https://github.com/badlogic/pi-mono) that adds a **flow engine**, **real-time dashboard**, and **orchestration toolkit** to pi. Design multi-agent workflows as markdown, execute them with parallel DAG scheduling, and monitor everything in a live TUI dashboard.

## Install

```bash
pi install git:github.com/BlackBeltTechnology/pi-flows
```

## What It Does

pi-flows turns pi into a multi-agent orchestration platform. Instead of talking to one model at a time, you define **flows** — directed acyclic graphs of specialized agents that run in parallel, pass results between each other, and branch on user input or agent decisions.

### Flow Engine

The core runtime that parses `.flow.md` files and executes them:

- **DAG scheduling** — agents run in parallel up to `max_concurrent`, respecting `blockedBy` dependencies
- **Template variables** — wire results between steps with `{result.step-id.summary}`, `{task}`, `{input.name}`, `{fork.id.answer}`, loop counters, and more
- **6 step types:**
  - `agent` — dispatch a named agent with task, inputs, and model override
  - `fork` — present choices to the user, branch accordingly (supports multi-select, freetext with AI routing)
  - `conditional` — branch based on presence of data in previous results
  - `agent-decision` — dispatch an agent to make a routing decision
  - `agent-loop-decision` — iterative verify/fix cycles with safety caps
  - `flow-ref` — delegate to sub-flows (supports glob patterns)
- **Guard extension** — injected into every spawned agent for sandboxing (access control, `.model` file protection, `finish` tool enforcement)
- **Model roles** — `@planning`, `@coding`, `@compact`, `@research` resolve to configured model IDs via the provider system
- **Structured results** — agents call a `finish` tool with status, summary, files, and artifacts; parsed into typed `AgentResult` objects

### Dashboard

A real-time TUI widget rendered above the editor:

- **Agent cards** in a responsive grid showing status (pending → running → complete/error), duration, token usage, and domain-specific metrics
- **Detail view** — `Ctrl+O` to toggle, arrow keys to navigate, expand individual agents to see full output, thinking traces, and tool call history
- **Breadcrumb navigation** — multi-stage workflows show progress through stages
- **Pluggable card renderers** — domain packages register custom card types via `flow:register-card` events
- **Workflow registry** — define named multi-stage workflows that map flow names to dashboard stages

### Flow Context

Manages flow results as reusable context:

- **`#flows:<name>`** — inline autocomplete in the editor; expands to the flow's saved result summary when sent
- **`/flows`** — action menu to create, list, inject, edit, or delete flows
- **`/flows:new`** — design a new flow interactively with the Flow Architect
- **`/flows:edit`** — modify an existing saved flow
- **`/flows:delete`** — remove a flow and its results

### Flow Workspace

Handles the flow creation and editing lifecycle:

- Analyzes conversation context to auto-generate flow descriptions
- Spawns the **Flow Architect** agent to design flows using `agent_catalog`, `flow_validate`, and `flow_write` tools
- **Replan loop** — review the designed flow, request changes, re-run the architect
- **Save & Run** — persist flows to `.pi/flows/` so they register as `/commands` on next session

### Provider System

Custom LLM provider registration with model catalog and role-based routing:

- **`/provider`** — add, list, or remove providers (OpenAI-compatible, Anthropic, custom)
- **`/roles`** — assign models to named roles (`@planning`, `@coding`, `@compact`, etc.)
- Config stored at `~/.pi/agent/providers.json`

### Footer & File Tracker

- Composable footer showing provider/model, git branch, file stats (insertions/deletions), and context window usage
- Session-scoped file tracking for both direct edits and subagent modifications
- Extension points for domain packages to register custom footer segments

## Agents

| Agent | Purpose |
|-------|---------|
| `flow-architect` | Designs custom flows from task descriptions using the agent catalog |
| `flow-decision` | Routes freetext user answers to the closest matching branch |
| `project-context-reader` | Discovers and reads project planning files, docs, and config |

## Extension Points

pi-flows is designed to be extended by domain packages. Events you can emit or listen to:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `flow:register-agents-dir` | emit → | Register an additional agents directory |
| `flow:register-flows-dir` | emit → | Register an additional flows directory |
| `flow:register-skills-dir` | emit → | Register an additional skills directory |
| `flow:register-card` | emit → | Register a custom dashboard card renderer |
| `flow:register-workflow` | emit → | Register a named multi-stage workflow |
| `flow:register-gate` | emit → | Register a prerequisite gate for flows |
| `flow:register-footer-segment` | emit → | Add a custom footer segment |
| `flow:complete` | ← listen | Flow execution finished (receives `FlowResult`) |
| `flow:run` | emit → | Programmatically trigger a flow by name |
| `flow:subagent-tool-call` | ← listen | Tool call from a running subagent |
| `flow:subagent-tool-result` | ← listen | Tool result from a running subagent |

## Flow File Format

Flows are `.flow.md` files with YAML frontmatter and `##`-delimited steps:

```markdown
---
name: my-flow
description: Does the thing
max_concurrent: 3
---

## researcher
task: Investigate the codebase for {task}

## developer
blockedBy: researcher
inputs:
  research_output: {result.researcher.summary}

## verifier
blockedBy: developer
```

## Agent File Format

Agents are `.md` files with YAML frontmatter and a system prompt body:

```markdown
---
name: my-agent
description: What this agent does
model: @coding
tools: read, write, edit, bash, grep
skills: my-docs
inputs:
  - research_output
card:
  type: developer
  label: "My Agent"
---

You are a specialized agent. Your task: {task}

Use the research context: {input.research_output}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) v0.58.4+
- Node.js 20.6+

## License

MIT
