# Creating Pi-Flow Packages

This guide walks through creating a custom pi-flows package from scratch.

## Package Structure

A pi-flow package is a standard npm package with a `pi` manifest:

```
my-package/
  package.json            # Must include "pi-package" keyword + "pi" manifest
  agents/                 # Agent definitions (Markdown with YAML frontmatter)
    my-agent.md
    helper-agent.md
  flows/                  # Flow definitions organized by namespace
    my-ns/
      main.flow.yaml
      helper.flow.yaml
  skills/                 # Reference documentation bundles
    my-skill/
      SKILL.md
      reference.md
  extensions/             # TypeScript lifecycle hooks
    my-ext/
      index.ts
  prompts/                # Custom prompt templates (optional)
  themes/                 # UI theme overrides (optional)
```

## Step 1: package.json

```json
{
  "name": "my-pi-package",
  "version": "1.0.0",
  "description": "My custom pi-flows package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/my-ext"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  },
  "peerDependencies": {
    "pi-flows": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "pi-flows": "git+ssh://git@github.com:BlackBeltTechnology/pi-flows.git",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@sinclair/typebox": "*"
  }
}
```

**Key fields:**
- `keywords: ["pi-package"]` — required for package discovery
- `pi.extensions` — paths to extension entry points
- `pi.skills` — paths to skill directories (engine scans for `SKILL.md` files)
- `pi.prompts` — custom prompt templates
- `pi.themes` — UI theme configurations

## Step 2: Writing Agents

### Agent File Format

Agents are Markdown files with YAML frontmatter in the `agents/` directory:

```markdown
---
name: my-agent                     # Unique identifier (used in flows)
description: Brief description     # Shown in agent catalog
model: @coding                     # AI model tier
tools: read, write, edit, grep, bash  # Allowed tools
skills: my-skill                   # Skills this agent can reference
inputs:                            # Named inputs from upstream steps
  - context_data
  - prior_output
card:                              # Dashboard card configuration
  metric: developer                # Metric type
  label: "My Agent"                # Display label
architect:                         # Agent-discovery metadata (surfaced by flow_agents op list)
  domain: backend                  # Domain category
  use_when: "When to auto-select"  # Selection criteria
access:                            # Filesystem sandbox
  read:
    - "src/**"
    - "docs/**"
  write:
    - "src/generated/**"
    - "docs/output/**"
  bash:
    deny:
      - "rm -rf"
      - "npm publish"
---

You are [role description]. [Behavioral instructions.]

## Your Task

${{task}}

## Input Context

${{input.context_data}}

${{input.prior_output}}

## Guidelines

- [Specific instructions for this agent]
- [What to do and what NOT to do]
- [Reference skills for documentation]

## Output Format

Call `finish` with your structured results when done.
```

### Agent Design Principles

1. **Single responsibility** — each agent should have one clear domain
2. **Least privilege** — declare only the tools and access the agent needs
3. **Explicit inputs** — use `inputs:` for dynamic data from upstream steps
4. **Clear boundaries** — `access:` patterns prevent agents from stepping on each other
5. **Structured output** — agents call `finish` to submit structured results for downstream steps

### Model Tier Selection

| Tier | When to Use | Cost | Capability |
|------|-------------|------|------------|
| `@coding` | Writing code, complex implementation | High | Best code generation |
| `@planning` | Orchestration, analysis, verification | Medium | Strong reasoning |
| `@research` | Read-only exploration, documentation | Medium | Good comprehension |
| `@compact` | Simple tasks, formatting, summarization | Low | Basic capability |

### Dashboard Card Types

| Type | Visual | Best For |
|------|--------|----------|
| `developer` | Code icon | Implementation agents |
| `researcher` | Search icon | Research/exploration agents |
| `tester` | Test icon | Testing agents |
| `writer` | Pen icon | Documentation/planning agents |
| `verifier` | Check icon | Verification agents |
| `default` | Generic | Everything else |

## Step 3: Writing Flows

### Flow File Format (YAML)

```yaml
name: my-flow
description: What this flow does
task_required: true                    # true → prompt user for input
task_prompt: "What should we do?"      # Prompt text (if task_required)
max_concurrent: 3                      # Max parallel agents

steps:
  - id: step-1
    agent: my-agent
    task: >
      Instructions for the agent.
      User request: ${{task}}

  - id: step-2
    agent: helper-agent
    blockedBy: [step-1]
    task: >
      Continue from step-1: ${{result.step-1.summary}}
    inputs:
      prior: "${{result.step-1.summary}}"
```

### Dependency Wiring

**No dependencies (parallel):**
```yaml
steps:
  - id: a
    agent: agent-a
  - id: b
    agent: agent-b
  # a and b run simultaneously
```

**Sequential:**
```yaml
steps:
  - id: a
    agent: agent-a
  - id: b
    agent: agent-b
    blockedBy: [a]
  # b waits for a
```

**Fan-out / fan-in:**
```yaml
steps:
  - id: source
    agent: data-collector

  - id: branch-a
    agent: processor-a
    blockedBy: [source]
  - id: branch-b
    agent: processor-b
    blockedBy: [source]

  - id: merge
    agent: merger
    blockedBy: [branch-a, branch-b]
    inputs:
      a: "${{result.branch-a.summary}}"
      b: "${{result.branch-b.summary}}"
```

### Common Patterns

**Research → Plan → Execute:**
```yaml
steps:
  - id: research
    agent: researcher
  - id: plan
    agent: planner
    blockedBy: [research]
  - id: execute
    agent: implementer
    blockedBy: [plan]
```

**Verify-Fix Loop:**
```yaml
steps:
  - id: implement
    agent: implementer

  - id: verify
    agent: verifier
    blockedBy: [implement]

  - id: fix
    agent: fixer
    blockedBy: [verify]
    inputs:
      issues: "${{result.verify.artifacts}}"

  - id: decision
    type: agent-loop-decision
    agent: flow-decision
    task: >
      Issues: ${{result.verify.artifacts}}
      Loop if issues remain, exit if clean.
    loop_target: fix
    exit_target: done
    max_iterations: 3

  - id: done
    agent: summarizer
```

**Interactive Branching:**
```yaml
steps:
  - id: choose
    type: fork
    question: "How thorough should the analysis be?"
    options: [Quick scan, Deep analysis]
    branches:
      Quick scan: quick
      Deep analysis: deep

  - id: quick
    agent: quick-scanner

  - id: deep
    agent: deep-analyzer

  - id: report
    agent: reporter
    blockedBy: [quick, deep]  # Runs after whichever branch was selected
```

## Step 4: Writing Skills

### Skill Structure

```
skills/
  my-skill/
    SKILL.md                # Required — index file
    api-reference.md        # Topic file
    patterns.md             # Topic file
    troubleshooting.md      # Topic file
```

### SKILL.md Template

```markdown
---
name: my-skill
description: What this skill provides
files:
  - api-reference.md
  - patterns.md
  - troubleshooting.md
---

# My Skill

Brief overview of what this skill covers and when agents should use it.

## Overview

Explain the domain, key concepts, and architecture.

## When to Use This Skill

- When implementing X
- When debugging Y
- When extending Z

## Key Principles

1. Principle one
2. Principle two

## Available Reference Files

- **api-reference.md** — API endpoints, request/response formats
- **patterns.md** — Common implementation patterns and examples
- **troubleshooting.md** — Common issues and solutions
```

### Topic File Best Practices

- Start with a `# Title` and brief overview paragraph
- Use `##` sections for major topics
- Include code examples in fenced blocks with language tags
- Keep files focused — one topic per file, under 500 lines
- Use "Best Practices" sections at the end of each file
- Reference other topic files where relevant

## Step 5: Writing Extensions

### Extension Template

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Register commands
  pi.registerCommand("my:command", {
    description: "Description shown in /help",
    handler: async (args, ctx) => {
      ctx.ui.notify("Command executed", "info");
    },
  });

  // Register tool call guard
  pi.on("tool_call", (event) => {
    // Inspect event.tool, event.args
    // Return { block: true, reason: "..." } to block
    // Return undefined to allow
  });

  // Register custom tool
  pi.registerTool("my_tool", {
    description: "Custom tool description",
    parameters: { /* TypeBox schema */ },
    handler: async (args) => {
      return { result: "tool output" };
    },
  });
}
```

### Guard Pattern

```typescript
pi.on("tool_call", (event) => {
  const { tool, args } = event;
  
  // Block specific file access
  if (tool === "write" && args.path?.startsWith("protected/")) {
    return {
      block: true,
      reason: "Cannot write to protected/ directory. Use the dedicated API instead.",
    };
  }
  
  // Block dangerous bash commands
  if (tool === "bash" && /rm\s+-rf/.test(args.command)) {
    return {
      block: true,
      reason: "rm -rf is not allowed. Use targeted file operations.",
    };
  }
});
```

## Testing Your Package

1. **Link locally** during development:
   ```bash
   cd my-package && npm link
   cd ../my-project && npm link my-pi-package
   ```

2. **Test agents individually** by running them directly:
   ```
   /agent my-agent "test task description"
   ```

3. **Test flows** end-to-end:
   ```
   /my-ns:my-flow
   ```

4. **Check agent resolution** — ensure all agents referenced in flows exist in the `agents/` directory.
