# pi-flows

A pi-package that adds multi-agent workflow orchestration to pi. Design flows as YAML DAGs, run them with automatic parallel scheduling, and watch everything in a live TUI dashboard — while the main session stays fully interactive.

---

## Overview

Flows are **reusable workflow templates** that coordinate multiple AI agents through structured inputs and outputs. Each agent runs in an isolated session with scoped tools and filesystem access.

**Best practice usage:**
- **Research → Plan → Implement → Verify** cycles
- **Code review** pipelines with verify/fix loops
- **Documentation generation** with multi-domain research
- **Refactoring** with interactive branching

## Installation

```bash
pi install npm:pi-flows
```

Or from a local clone:

```bash
pi install /path/to/pi-flows
```

## Quick Start

1. **Create an agent** (`.pi/flows/agents/reviewer.md`):

   ```markdown
   ---
   name: reviewer
   description: Reviews code for quality issues
   model: @coding
   tools: read, grep, find
   inputs:
     - target_path
   ---
   Review the code for: ${{task}}
   Focus on: ${{input.target_path}}
   ```

2. **Create a flow** (`.pi/flows/flows/review.yaml`):

   ```yaml
   name: review
   description: Research then review code
   task_required: true
   task_prompt: "What should I review?"

   steps:
     - id: research
       agent: project-context-reader
       task: Investigate the codebase for ${{task}}

     - id: review
       agent: reviewer
       blockedBy: [research]
       inputs:
         target_path: "${{result.research.summary}}"
       task: Review based on research findings
   ```

3. **Run it:**

   ```
   /review Fix the auth middleware
   ```

## Commands & Keybindings

| Command | Description |
|---------|-------------|
| `/flows` | Manage flows (new, edit, delete) |
| `/flows:new` | Design & run a new flow with the Flow Architect |
| `/flows:edit` | Edit an existing flow |
| `/flows:delete` | Delete a flow |
| `/roles` | Assign models to role tiers (@coding, @planning, etc.) |
| `Ctrl+A` | Toggle auto-routing (agents decide fork branches autonomously) |
| `Ctrl+X` | Abort running flow |

Flows also register as slash commands based on file path: `.pi/flows/flows/review.yaml` → `/review`.

## Core Concepts

- **Agents** — Markdown files with YAML frontmatter (config) and body (system prompt). Run in isolated sessions with scoped tools and file access.
- **Flows** — YAML files defining a DAG of steps connected via `blockedBy`. The engine schedules independent steps in parallel, up to `max_concurrent`.
- **Template variables** — `${{task}}`, `${{result.step-id.summary}}`, `${{input.name}}` wire data between steps at dispatch time.
- **Model roles** — `@coding`, `@planning`, `@research`, `@compact` map to concrete models via `/roles`. Each agent declares which tier it needs.
- **Flow Architect** — A built-in AI agent (`/flows:new`) that analyzes your conversation context, selects agents from the catalog, and designs a complete flow DAG.

## Writing Agents

Agents are `.md` files in `.pi/flows/agents/` (project-local) or a package's `agents/` directory.

```markdown
---
name: backend-dev
description: Implements backend changes
model: @coding
thinking: high
tools: read, write, edit, grep, bash
inputs:
  - research_context
outputs:
  - verdict
access:
  read: ["src/**"]
  write: ["src/main/**"]
  bash:
    deny: ["rm -rf"]
card:
  label: "Backend Dev"
  metric: developer
---
You are a backend developer. Task: ${{task}}
Context: ${{input.research_context}}
```

**Key fields:** `model` (role tier), `tools` (allowlist — guard blocks everything else), `inputs`/`outputs` (typed data flow), `access` (filesystem sandbox), `card` (TUI dashboard rendering).

## Writing Flows

### Step Types

**Agent** — dispatch a named agent with a task:
```yaml
- id: impl
  agent: backend-dev
  blockedBy: [research]
  inputs:
    research_context: "${{result.research.summary}}"
```

**Fork** — present a choice to the user (or let an agent decide in auto-routing mode):
```yaml
- id: choose
  type: fork
  question: "Which approach?"
  options: [Quick fix, Full refactor]
  branches:
    Quick fix: quick-step
    Full refactor: refactor-step
  agent: flow-decision    # used when Ctrl+A is active
```

**Conditional** — branch on whether a result field is empty:
```yaml
- id: check
  type: conditional
  check: researcher.artifacts
  present: process-step
  absent: skip-step
```

**Agent Loop Decision** — iterative verify/fix cycles:
```yaml
- id: verify-loop
  type: agent-loop-decision
  agent: flow-decision
  task: "Check iteration ${{loop.verify-loop.iteration}}/${{loop.verify-loop.max}}"
  loop_target: fixer
  exit_target: done
  max_iterations: 3
```

**Flow Reference** — delegate to a sub-flow:
```yaml
- id: run-tests
  type: flow-ref
  path: .pi/flows/flows/test-suite.yaml
```

## Input Wiring

Steps pass data through `inputs` + template variables:

```yaml
- id: researcher
  agent: researcher
  task: Investigate ${{task}}

- id: developer
  agent: developer
  blockedBy: [researcher]
  inputs:
    context: "${{result.researcher.summary}}"
    spec: file://specs/api-spec.md    # injects file content
```

The agent's prompt references inputs as `${{input.context}}`. Typed outputs declared in agent frontmatter (`outputs:`) are accessible as `${{result.step-id.outputName}}`.

## TUI Dashboard

When flows run, a live dashboard appears with agent cards in a grid layout. Each card shows status, elapsed time, and domain-specific metrics (files modified, tests passed, etc.). Navigate with arrow keys, expand agent detail views, and see the full flow summary after completion.

Card types (`card.metric`): `developer`, `researcher`, `tester`, `verifier`, `writer`, `default` — or register custom renderers via `flow:register-card`.

## Integration with pi-agent-dashboard

pi-flows is the **engine**. The browser dashboard rendering of flow events lives in [`pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) as a separate workspace plugin (`packages/flows-plugin/`). The two repos are intentionally split: pi-flows emits `flow:*` events; the dashboard reacts to them.

See [`docs/dashboard-integration.md`](docs/dashboard-integration.md) for the architecture diagram, the wire-protocol bridge, and how to add new flow events end-to-end.

## Built-in Agents

| Agent | Role | Description |
|-------|------|-------------|
| `flow-architect` | Orchestrator | Designs flows from conversation context using `agent_catalog` |
| `flow-decision` | Router | Makes branch/loop decisions for fork and loop steps |
| `project-context-reader` | Researcher | Reads and summarizes project structure |

## Developer Docs

Detailed documentation in the `docs/` folder:

- [Flows Reference](docs/flows.md) — Complete step type reference with syntax and examples
- [Agents Reference](docs/agents.md) — Agent frontmatter schema, model tiers, card types
- [Flow Authoring](docs/flow-authoring.md) — Full format reference for agent and flow files
- [Architecture](docs/architecture.md) — Internal design: DAG execution, agent isolation, sub-extensions
- [Events API](docs/events-api.md) — Register custom cards, tools, and listen to flow events
- [Public API](docs/public-api.md) — Core TypeScript types and functions for programmatic use
- [Skills & Extensions](docs/skills-and-extensions.md) — Skill bundles and extension registration
- [Tools Reference](docs/tools-reference.md) — Built-in tools available to agents
- [Creating Packages](docs/creating-packages.md) — Build domain packages with custom agents and flows
- [Extending pi-flows](docs/extending-pi-flows.md) — Advanced customization
- [Dashboard Integration](docs/dashboard-integration.md) — How pi-flows and pi-agent-dashboard connect

## License

MIT
