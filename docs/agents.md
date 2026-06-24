# Agent Reference

> Developer documentation for pi-flows agents. For user-facing docs, see [README.md](../README.md).

This document provides a comprehensive reference for agent definitions in pi-flows — their frontmatter schema, tool access, inter-agent data flow, and sandbox boundaries.

## Agent Definition Format

Every agent is a Markdown file with YAML frontmatter in the `agents/` directory:

```markdown
---
name: agent-name                  # Unique identifier
description: What this agent does # Brief description
model: @coding                    # Model tier
thinking: high                    # Optional: thinking depth
tools: read, write, bash          # Tool allowlist
skills: skill-name                # Skill bundles (comma-separated or list)
inputs:                           # Named inputs from upstream steps
  - input_name
card:                             # Dashboard rendering
  type: developer                 # Maps to card renderer class
  metric: developer               # Metric tracking category
  label: "Display Name"           # Human-readable label
architect:                        # Flow-architect metadata
  domain: backend                 # Domain classification
  use_when: "When to select this agent"
  produces: "What this agent outputs"
access:                           # Filesystem sandbox
  read: ["src/**"]
  write: ["src/custom/**"]
  bash:
    deny: ["rm -rf"]
---

System prompt and instructions follow here.
Supports ${{task}} and ${{input.<name>}} interpolation.
```

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | ✓ | string | Unique agent identifier, used in flow step `agent:` field |
| `description` | ✓ | string | Brief description shown in catalogs and dashboards |
| `model` | ✓ | string | Model tier: `@coding`, `@planning`, `@research`, `@compact` |
| `thinking` | | string | Thinking depth override (e.g., `high`) |
| `tools` | ✓ | string/list | Comma-separated tool allowlist |
| `skills` | | string/list | Skill bundle names loaded via `skill_read` |
| `inputs` | | list | Named inputs populated from upstream step results (bare names — no typing or validation) |
| `outputs` | | list | Named output values extracted from `finish` params (typed outputs, required by default) |
| `fork_session` | | boolean | When `true`, the spawned agent inherits the operator's (main session's) conversation data. Default `false`. |
| `context_files` | | list | Paths read at spawn time and injected into the agent's system prompt as `## Context: <path>` preamble sections |
| `card` | | object | Dashboard card configuration |
| `card.metric` | | string | Metric renderer name (maps to registered card renderers) |
| `card.label` | | string | Display label in the dashboard |
| `architect` | | object | Flow-architect metadata for agent selection |
| `architect.domain` | | string | Domain classification for the agent |
| `architect.use_when` | | string | Natural language description of when to select this agent |
| `architect.produces` | | string | Description of what this agent outputs |
| `access` | | object | Filesystem sandbox boundaries |
| `access.read` | | list | Glob patterns for readable paths |
| `access.write` | | list | Glob patterns for writable paths |
| `access.bash` | | object | Bash command restrictions |
| `access.bash.deny` | | list | Denied bash command patterns |

## Model Tiers

| Tier | Use Case | Cost |
|------|----------|------|
| `@coding` | Implementation requiring code generation | High |
| `@planning` | Orchestration, analysis, and verification | Medium-High |
| `@research` | Read-only exploration and analysis | Medium |
| `@compact` | Lightweight tasks (summaries, formatting) | Low |

## Card Types

Each agent's `card.metric` maps to a renderer class registered by the extension or a domain package:

| Card Type | Visual | Best For |
|-----------|--------|----------|
| `developer` | Code icon | Implementation agents |
| `researcher` | Search icon | Research/exploration agents |
| `tester` | Test icon | Testing agents |
| `writer` | Pen icon | Documentation/planning agents |
| `verifier` | Check icon | Verification agents |
| `default` | Generic | Everything else |

Custom card types can be registered by domain packages via `flow:register-card`. See [extending-pi-flows.md](extending-pi-flows.md).

---

## Typed Outputs

Agents can declare named outputs in their frontmatter. When the agent calls `finish`, values matching these names are extracted from the finish parameters and made available to downstream steps as `${{result.STEP.outputName}}`.

```yaml
outputs:
  - name: findings
    description: Key findings from the analysis
  - name: verdict
    description: Pass/fail verdict
```

Simple array form (without descriptions):

```yaml
outputs: [findings, verdict]
```

### Output content constraints (`type` / `pattern`)

In the expanded form, each output accepts two optional fields:

- `type: string | number | boolean` — constrains the string content. `type: number` requires a numeric string; `type: boolean` requires `true` or `false`.
- `pattern: <regex>` — requires the string to match the given regex.

Output values remain **string-valued** — downstream still reads `${{result.STEP.name}}` as a string. `type` and `pattern` are content constraints on that string, not type conversions. An explicit `pattern` takes precedence over `type`. An invalid regex degrades to an unconstrained required string.

```yaml
outputs:
  - name: file_path
    description: Absolute path to the generated file
    pattern: "^/.+"
  - name: count
    type: number
```

### Outputs are required by default

Declared outputs are **required**. If an agent calls `finish` without a declared output, or with a value that violates its `type`/`pattern`, the finish call is rejected and the agent is re-prompted (the existing finish retry loop). The step fails once retries are exhausted (`MAX_FINISH_RETRIES`). This is enforced at the finish-tool schema level. Existing agents that declared outputs but sometimes omitted them will now be retried and may fail.

Inputs are unchanged — still bare names with no typing or validation. The validated output's name carries the contract; inputs need no symmetric typing.

The agent calls `finish` with matching parameter names:

```
finish(summary="Analysis complete.", findings="Found 3 issues...", verdict="fail")
```

Downstream steps reference them:

```yaml
task: "Verdict was: ${{result.analyzer.verdict}}. Details: ${{result.analyzer.findings}}"
```

## Agent Design Principles

1. **Single responsibility** — each agent should have one clear domain
2. **Least privilege** — declare only the tools and access the agent needs
3. **Explicit inputs** — use `inputs:` for dynamic data from upstream steps
4. **Clear boundaries** — `access:` patterns prevent agents from stepping on each other
5. **Structured output** — agents call `finish` to produce structured results for downstream steps

---

## Example: Research Agent

A typical read-only research agent:

```markdown
---
name: backend-researcher
description: Investigates backend code patterns and conventions
model: @research
tools: read, grep, find, ls, skill_read
skills: my-backend-docs
inputs:
  - prior_context
card:
  type: researcher
  metric: researcher
  label: "Backend Research"
architect:
  domain: backend
  use_when: "When backend code investigation is needed"
  produces: "Analysis of backend patterns and conventions"
access:
  read:
    - "src/**"
    - "docs/**"
  write:
    - "research/backend.md"
---

You are a backend researcher. Your task: ${{task}}

Prior context:
${{input.prior_context}}

Investigate the backend code thoroughly. Focus on patterns, conventions, and architecture.
```

**Key behaviors:**
- Read-only tools (no `write`, `edit`, or `bash`)
- Sandboxed to specific directories
- Receives upstream context through `inputs`
- Produces structured findings via `finish`

---

## Example: Implementation Agent

A typical code-writing agent:

```markdown
---
name: backend-developer
description: Implements backend changes based on research findings
model: @coding
tools: read, write, edit, grep, find, ls, bash, skill_read
skills: my-backend-docs
inputs:
  - research_output
  - task_description
card:
  type: developer
  metric: developer
  label: "Backend Dev"
architect:
  domain: backend
  use_when: "When backend code changes are needed"
  produces: "Modified source files"
access:
  read:
    - "src/**"
    - "docs/**"
  write:
    - "src/main/**"
    - "src/test/**"
  bash:
    deny:
      - "rm -rf"
---

You are a backend developer. Your task: ${{task}}

Research context:
${{input.research_output}}

Task details:
${{input.task_description}}

Implement clean, tested code following existing conventions.
```

---

## Example: Verification Agent

A typical verification/build agent:

```markdown
---
name: verifier
description: Builds the project and verifies acceptance criteria
model: @planning
tools: read, grep, find, ls, bash, skill_read
inputs:
  - implementation_output
card:
  type: verifier
  metric: verifier
  label: "Verifier"
architect:
  domain: verification
  use_when: "When implementation needs to be verified"
  produces: "Verification report with gaps"
access:
  read:
    - "**/*"
  write:
    - "verification.md"
---

You are a verifier. Your task: ${{task}}

Implementation summary:
${{input.implementation_output}}

Build the project and verify all acceptance criteria.
Report any gaps found.
```

**Gap reporting format:**
```xml
<result status="complete">
  <artifacts>
    <gaps count="2">
      <gap id="G1" severity="critical" agent="backend-developer" criterion="...">
        Description of what's missing.
      </gap>
      <gap id="G2" severity="major" agent="frontend-developer" criterion="...">
        Description of what's missing.
      </gap>
    </gaps>
  </artifacts>
  <summary>Found 2 gaps requiring fixes.</summary>
</result>
```

---

## Agent Dependency Patterns

Agents typically form dependency chains through flow wiring:

```
                    ┌───────────────────┐
                    │    Researcher     │
                    └────────┬──────────┘
                    ┌────────┴──────────┐
                    │                   │
              ┌─────▼──────┐    ┌───────▼────────┐
              │  Backend   │    │   Frontend     │
              │ Developer  │    │  Developer     │
              └─────┬──────┘    └───────┬────────┘
                    │                   │
              ┌─────▼──────┐    ┌───────▼────────┐
              │  Backend   │    │   E2E Tester   │
              │  Tester    │    │                │
              └─────┬──────┘    └───────┬────────┘
                    └────────┬──────────┘
                    ┌────────▼──────────┐
                    │     Verifier      │
                    └────────┬──────────┘
                    ┌────────▼──────────┐
                    │    Summarizer     │
                    └───────────────────┘
```

These dependencies are expressed through `blockedBy` in flow steps and `inputs` wiring. The agents themselves don't know about each other — the flow orchestrates data passing between them.

## Tool Availability Guidelines

| Agent Role | Typical Tools | Notes |
|------------|---------------|-------|
| Researcher | `read`, `grep`, `find`, `ls`, `skill_read` | Read-only, no file modification |
| Developer | `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `skill_read` | Full dev access, sandboxed paths |
| Tester | `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `skill_read` | Similar to developer, test-focused paths |
| Verifier | `read`, `grep`, `find`, `ls`, `bash`, `skill_read` | Build access, limited writes |
| Planner | `read`, `write`, `grep`, `skill_read` | Document generation, no bash |
| Summarizer | `read`, `write`, `grep` | Lightweight, document-focused |

> **`finish` is automatic.** Every agent automatically has the `finish` tool — do not declare it. Agents *must* call `finish` as their last action to submit structured results.
