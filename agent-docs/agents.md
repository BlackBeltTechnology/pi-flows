# Agent Reference

> Developer docs for pi-flows agents. User docs: [README.md](../README.md).

Reference for agent definitions: frontmatter schema, tool access, inter-agent data flow, sandbox boundaries.

## Agent Definition Format

Each agent: Markdown file with YAML frontmatter in `agents/`:

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
architect:                        # Agent-discovery metadata (surfaced by flow_agents op list)
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
| `inputs` | | list | Named inputs from upstream step results. Bare names. No typing. No validation. |
| `outputs` | | list | Named output values extracted from `finish` params. Typed outputs. Required by default. |
| `fork_session` | | boolean | `true` forks operator main session conversation data into spawned agent. Default `false`. |
| `context_files` | | list | Paths read at spawn time. Injected into system prompt as `## Context: <path>` preamble sections. |
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

`card.metric` maps to renderer class registered by extension or domain package:

| Card Type | Visual | Best For |
|-----------|--------|----------|
| `developer` | Code icon | Implementation agents |
| `researcher` | Search icon | Research/exploration agents |
| `tester` | Test icon | Testing agents |
| `writer` | Pen icon | Documentation/planning agents |
| `verifier` | Check icon | Verification agents |
| `default` | Generic | Everything else |

Domain packages register custom card types via `flow:register-card`. See [extending-pi-flows.md](extending-pi-flows.md).

---

## Typed Outputs

Agents declare named outputs in frontmatter. On `finish`, values matching names extract from finish params. Downstream steps access as `${{result.STEP.outputName}}`.

```yaml
outputs:
  - name: findings
    description: Key findings from the analysis
  - name: verdict
    description: Pass/fail verdict
```

Simple array form (no descriptions):

```yaml
outputs: [findings, verdict]
```

### Output content constraints (`type` / `pattern`)

Expanded output accepts two optional fields:

- `type: string | number | boolean` — constrains string content. `type: number` requires numeric string. `type: boolean` requires `true` or `false`.
- `pattern: <regex>` — requires string to match regex.

Output values stay string-valued. Downstream reads `${{result.STEP.name}}` as string. `type` and `pattern` constrain string content. No type conversion. Explicit `pattern` overrides `type`. Invalid regex degrades to unconstrained required string.

```yaml
outputs:
  - name: file_path
    description: Absolute path to the generated file
    pattern: "^/.+"
  - name: count
    type: number
```

### Outputs required by default

Declared outputs are required. `finish` without declared output, or with value violating `type`/`pattern`, rejects the call. Agent re-prompts via finish retry loop. Step fails after retries exhausted (`MAX_FINISH_RETRIES`). Enforced at finish-tool schema level. Existing agents declaring outputs but omitting them now retry and may fail.

Inputs unchanged. Still bare names. No typing. No validation. Validated output name carries contract. Inputs need no symmetric typing.

Agent calls `finish` with matching param names:

```
finish(summary="Analysis complete.", findings="Found 3 issues...", verdict="fail")
```

Downstream step reference:

```yaml
task: "Verdict was: ${{result.analyzer.verdict}}. Details: ${{result.analyzer.findings}}"
```

## Agent Design Principles

1. **Single responsibility** — one clear domain per agent
2. **Least privilege** — declare only needed tools and access
3. **Explicit inputs** — use `inputs:` for upstream data
4. **Clear boundaries** — `access:` patterns prevent collisions
5. **Structured output** — agents call `finish` to emit structured results

---

## Example: Research Agent

Read-only research agent:

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
- Read-only tools (no `write`, `edit`, `bash`)
- Sandboxed to specific directories
- Upstream context via `inputs`
- Structured findings via `finish`

---

## Example: Implementation Agent

Code-writing agent:

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

Verification/build agent:

```markdown
---
name: verifier
description: Builds the project and verifies acceptance criteria
model: @planning
tools: read, grep, find, ls, bash, skill_read
inputs:
  - implementation_output
outputs:
  - name: gaps
    type: array
    description: List of gaps requiring fixes (empty when clean)
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

**Gap reporting format:** declare a typed `gaps` output (array) and emit via `finish`. Stored under the result's `outputs`, read downstream as `${{result.verify.gaps}}`.
```
finish({
  status: "complete",
  summary: "Found 2 gaps requiring fixes.",
  gaps: [
    { id: "G1", severity: "critical", agent: "backend-developer", criterion: "...", detail: "..." },
    { id: "G2", severity: "major",    agent: "frontend-developer", criterion: "...", detail: "..." }
  ]
})
```

---

## Agent Dependency Patterns

Agents form dependency chains via flow wiring:

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

Dependencies expressed via `blockedBy` in flow steps and `inputs` wiring. Agents don't know about each other — flow orchestrates data passing.

## Tool Availability Guidelines

| Agent Role | Typical Tools | Notes |
|------------|---------------|-------|
| Researcher | `read`, `grep`, `find`, `ls`, `skill_read` | Read-only, no file modification |
| Developer | `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `skill_read` | Full dev access, sandboxed paths |
| Tester | `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `skill_read` | Similar to developer, test-focused paths |
| Verifier | `read`, `grep`, `find`, `ls`, `bash`, `skill_read` | Build access, limited writes |
| Planner | `read`, `write`, `grep`, `skill_read` | Document generation, no bash |
| Summarizer | `read`, `write`, `grep` | Lightweight, document-focused |

> **`finish` is automatic.** Every agent gets `finish` tool — do not declare. Agents *must* call `finish` as last action to submit structured results.
