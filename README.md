# pi-flows

A pi-package that adds multi-agent workflow orchestration to pi. Design flows as YAML files, run them with automatic parallel scheduling, and watch everything in a live dashboard — while the main session stays fully interactive.

---

## Overview

Flows are **workflow templates** that can be reused across projects. They allow you to define processes where multiple agents communicate through structured inputs and outputs. 

**Best Practice Usage:**
- **Research → Plan → Implement → Verify** cycles
- **Code review** pipelines
- **Documentation generation**
- **Refactoring** loops

## Installation & Setup

1. Install the package via npm (or your preferred package manager):
   ```bash
   npm install pi-flows
   ```
2. Ensure pi-flows is added to your project's `pi` extensions configuration in `package.json`:
   ```json
   "pi": {
     "extensions": ["pi-flows"]
   }
   ```

## Quick Start

Create a simple workflow to review a file.

1. **Create an agent (`agents/reviewer.md`):**
   ```yaml
   ---
   id: simple-reviewer
   name: Code Reviewer
   description: Reviews code.
   inputs:
     type: object
     properties:
       code:
         type: string
   ---
   Review the provided code: ${{input.code}}
   ```

2. **Create a flow (`flows/review.yaml`):**
   ```yaml
   id: basic-review
   name: Basic Review Flow
   description: Reviews a single piece of code.
   inputs:
     type: object
     properties:
       targetCode:
         type: string
   steps:
     - id: review_step
       type: agent
       agent: simple-reviewer
       inputs:
         code: ${{input.targetCode}}
   ```

3. Run it using the pi CLI or TUI by triggering the `basic-review` flow and providing the `targetCode` input.

## Core Concepts

- **Agents:** Defined in `.md` files. They contain the system prompt (body) and configuration (frontmatter).
- **Flows:** Defined in `.yaml` files. They represent a Directed Acyclic Graph (DAG) of steps.
- **DAG Execution:** Steps run in parallel automatically unless constrained by `dependsOn` or input dependencies.
- **Template Variables:** Used to pass data between steps dynamically using `${{ }}` syntax.

## Writing Agents

Agents are configured via frontmatter in their markdown files.

```yaml
---
id: planner
name: Architecture Planner
role: architect
tools: [read, grep]
inputs:
  type: object
  properties:
    feature: { type: string }
---
You are an architect. Plan the implementation for: ${{input.feature}}
```

**Key Fields:**
- `id`, `name`, `description`: Metadata.
- `role`: Ties the agent to specific model presets.
- `tools`: Grants access to specific tools (e.g., `read`, `write`).
- `inputs`: JSON schema for the expected input.

## Writing Flows

Flows coordinate agents and logic.

### Agent Step
```yaml
- id: my_agent_step
  type: agent
  agent: planner
  inputs:
    feature: "User Auth"
```

### Fork Step (Parallel execution)
```yaml
- id: process_all
  type: fork
  items: ${{input.files}}
  itemVar: file
  step:
    type: agent
    agent: file-analyzer
    inputs:
      target: ${{file}}
```

### Conditional Step
```yaml
- id: fix_code
  type: conditional
  condition: ${{steps.test.output.failed}}
  step:
    type: agent
    agent: fixer
```

## Template Variables

Variables let you wire inputs and outputs together:
- `${{input.myVar}}`: Global flow input.
- `${{steps.stepId.output.result}}`: Data outputted by a previous step via `set_step_output`.
- `${{steps.stepId.summary}}`: The summary string provided by the step.

## Input Wiring

To pass data from step A to step B, map it in the `inputs` section:

```yaml
steps:
  - id: step_A
    type: agent
    agent: generator
  - id: step_B
    type: agent
    agent: reviewer
    dependsOn: [step_A]
    inputs:
      codeToReview: ${{steps.step_A.output.generatedCode}}
```

## Dashboard & Cards

pi-flows includes a rich TUI dashboard. When flows run, they appear in the dashboard. Each agent can have custom UI cards registered via the `flow:register-card` event to display real-time metrics and progress.

## Configuration

Flows and Agents are automatically discovered if placed in configured directories. You can extend functionality by hooking into the Events API.

## Developer Docs

For advanced customization, check the detailed documentation in the `docs/` folder:

- [Events API](docs/events-api.md): Register custom providers, cards, and listen to flow events.
- [Tools Reference](docs/tools-reference.md): Understand built-in tools.
- [Extending pi-flows](docs/extending-pi-flows.md): Build your own extensions.
- [Flow Authoring](docs/flow-authoring.md): Complete schema reference.
- [Public API](docs/public-api.md): Core TS types and functions.
