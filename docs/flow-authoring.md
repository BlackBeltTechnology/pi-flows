# Flow Authoring Reference

This document is the complete format reference for agent `.md` files and flow `.yaml` files. It covers every frontmatter field, step type, and template variable available in pi-flows.

---

## Agent Files (`.md`)

Agent files are Markdown documents with YAML frontmatter. The frontmatter configures the agent; the Markdown body is the system prompt.

### Frontmatter structure

```markdown
---
name: my-agent
description: A one-line description of what this agent does
model: @coding
thinking: medium
tools: read, grep, bash
skills: my-docs
inputs:
  - context
  - target_file
outputs:
  - name: findings
    description: Categorized issues found
  - name: verdict
    description: "pass" or "fail"
interactive: false
output: results.md
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
card:
  label: "My Agent"
  metric: "default"
  role: "implementer"
architect:
  use_when: "When the user needs to analyze source code"
  produces: "A findings report and a pass/fail verdict"
  depends_on: "project-context-reader"
  domain: "analysis"
---

# System Prompt

You are My Agent. Your task is: ${{task}}

Context provided: ${{input.context}}
Target file: ${{input.target_file}}
```

---

### Frontmatter field reference

#### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique agent identifier. Referenced in flow steps (`agent: my-agent`) and in `agent_catalog`. Must be unique across all registered agents. |
| `description` | `string` | Human-readable description. Shown in listings and used by the Architect to understand the agent's purpose. |
| `model` | `string` | Model reference. See **Model references** below. |
| `tools` | `string` | Comma-separated list of tools the agent may use. The guard blocks any tool not in this list. |

#### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `thinking` | `string` | — | Extended thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Overrides any thinking suffix in `model`. |
| `skills` | `string` | — | Comma-separated skill names. Each skill's `SKILL.md` is injected into the system prompt. Topic files are accessed via `skill_read`. |
| `inputs` | `string[]` | — | Declared input names. These become available as `${{input.NAME}}` in the system prompt. The flow step must wire them via `inputs:`. |
| `outputs` | `string[]` or object array | — | Declared output names. These are added as parameters on the `finish` tool and accessible as `${{result.STEP.outputName}}` in downstream steps. |
| `interactive` | `boolean` | `false` | If `true`, the agent session allows interactive UI prompts mid-task. |
| `output` | `string` | — | Default output file path (hint for display; not enforced). |
| `access` | block | — | Access control rules. See **Access control** below. |
| `card` | block | — | Dashboard card configuration. See **Card configuration** below. |
| `architect` | block | — | Metadata used by the Architect when deciding which agents to use. See **Architect metadata** below. |

---

### Model references

The `model` field accepts three formats:

| Format | Example | Description |
|--------|---------|-------------|
| Role alias | `@planning` | Resolved via the active role-to-model mapping (set with `/roles` command). |
| Model ID with thinking | `claude-sonnet-4-20250514:high` | Explicit model ID; `:high` sets thinking level unless `thinking:` field overrides it. |
| Plain model ID | `claude-haiku-3-5-20241022` | Used as-is; thinking from `thinking:` field or none. |

**Available built-in roles:** `@planning`, `@coding`, `@fast`, `@architect`. Custom roles can be added via the `/roles` command.

---

### Tools reference

The `tools:` field is a comma-separated list. Standard tools:

| Tool name | Description |
|-----------|-------------|
| `read` | Read file contents |
| `write` | Write files |
| `edit` | Edit files with exact text replacement |
| `grep` | Search file contents |
| `find` | Find files by name/pattern |
| `ls` | List directory contents |
| `bash` | Run shell commands |
| `ask_user` | Ask the user a structured question |
| `skill_read` | Read a skill topic file |

Extension-registered tools (via `flow:register-tool`) can also be listed here by name.

---

### Inputs and outputs

#### Inputs

```markdown
---
inputs:
  - research_context
  - target_path
---
You are analyzing: ${{input.target_path}}

Context from previous research:
${{input.research_context}}
```

- Each input name must be wired in the flow step's `inputs:` block.
- Unset inputs expand to empty string.
- Use `file://` prefix in the flow's `inputs:` value to inject file content (see [File content injection](#file-content-injection)).

#### Outputs

Simple format (names only):
```markdown
---
outputs:
  - findings
  - verdict
---
```

Expanded format (with descriptions):
```markdown
---
outputs:
  - name: findings
    description: Categorized list of issues found
  - name: verdict
    description: "pass" or "fail"
---
```

Declared outputs become parameters on the `finish` tool. The agent sets them when calling `finish`:
```
finish({
  status: "complete",
  summary: "Analysis complete",
  files: [],
  findings: "Found 3 critical issues...",
  verdict: "fail"
})
```

Downstream steps access them as: `${{result.STEP_ID.findings}}`, `${{result.STEP_ID.verdict}}`.

---

### Access control

```markdown
---
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
      - "npm publish*"
---
```

| Block | Description |
|-------|-------------|
| `access.read` | Glob patterns for allowed `read` and `grep` paths. If set, reads outside these patterns are blocked. |
| `access.write` | Glob patterns for allowed `write` and `edit` paths. If set, writes outside these patterns are blocked. |
| `access.bash.deny` | Command patterns to block in `bash`. Glob-style matching against the full command string. |

Patterns support `*` (any path segment) and `**` (any depth).

---

### Card configuration

```markdown
---
card:
  label: "Code Reviewer"
  metric: "files"
  role: "reviewer"
---
```

| Field | Description |
|-------|-------------|
| `card.label` | Display name shown in the dashboard card header. |
| `card.metric` | Metric renderer to use: `"default"` (progress/status), `"files"` (file count), `"tests"` (test pass/fail), or a custom name registered via `flow:register-card`. |
| `card.role` | Role label displayed in the card (decorative, for multi-role pipelines). |

---

### Architect metadata

```markdown
---
architect:
  use_when: "User wants to review code for quality and correctness"
  produces: "A detailed review with findings and a pass/fail verdict"
  depends_on: "An implementer or writer must have produced code first"
  domain: "review"
---
```

| Field | Description |
|-------|-------------|
| `architect.use_when` | When the Architect should consider using this agent. Plain English sentence. |
| `architect.produces` | What this agent outputs. Helps the Architect wire downstream steps. |
| `architect.depends_on` | What must run before this agent. Guides dependency ordering. |
| `architect.domain` | Logical domain grouping: `"research"`, `"implementation"`, `"review"`, `"orchestration"`, etc. |

The Architect agent (`flow-architect`) reads these fields from `agent_catalog` when designing flows.

---

## Flow Files (`.yaml`)

Flows are YAML files that define an ordered list of steps. The engine splits steps into DAG segments (parallel agent groups) separated by control-flow steps.

### Top-level structure

```yaml
name: my-flow                    # REQUIRED — becomes the slash-command name
description: What this flow does # REQUIRED — shown in listings
max_concurrent: 3                # optional — parallel agent cap (default: 4)
task_required: true              # optional — prompt user for task if no args given
task_prompt: "Enter your task:"  # optional — custom prompt text

steps:
  - ...
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Unique flow identifier. Becomes the slash-command. Subfolders add a `:` prefix: `flows/judo/build.yaml` → `judo:build`. |
| `description` | Yes | — | Human-readable description. Shown in `/help` and flow listings. |
| `steps` | Yes | — | Ordered list of flow steps. |
| `max_concurrent` | No | `4` | Maximum number of agent steps running in parallel within a DAG segment. |
| `task_required` | No | `false` | When `true`, prompts the user for a task description if the slash-command is invoked with no arguments. The answer becomes `${{task}}`. |
| `task_prompt` | No | `"Describe what you want <name> to do:"` | Custom prompt text shown when `task_required` triggers. |

---

### Execution model

The engine splits the flat step list into **segments**:

```
steps: [A, B, C, fork, D, E, loop-decision, F]
        ──────────  ────  ──────  ─────────────  ──
         DAG seg    sep   DAG seg    sep          DAG seg
         parallel         parallel
         (A||B||C)        (D||E)                  (F)
```

- **DAG segments** — consecutive `agent` steps. Executed as a parallel wave, respecting `blockedBy` dependencies. All steps in a wave that have no unsatisfied `blockedBy` entries fire concurrently, up to `max_concurrent`.
- **Separator steps** — `fork`, `conditional`, `agent-decision`, `agent-loop-decision`, `flow-ref`. Execute one at a time and control routing.
- **Cross-segment routing** — `on_complete` and `on_error` on agent steps can jump to any step ID, including steps in different segments.

---

### Step types

Every step requires a unique `id` field. The `type` field is optional — the engine infers type from which fields are present:

| Has field | Inferred type |
|-----------|--------------|
| `loop_target` | `agent-loop-decision` |
| `question` | `fork` |
| `check` | `conditional` |
| `path` (no `agent`) | `flow-ref` |
| `branches` (no `question`) | `agent-decision` |
| `agent` or none | `agent` |

Use explicit `type:` when the inference would be ambiguous.

---

#### 1. Agent step

The primary step type. Dispatches a named agent with an optional task and inputs.

```yaml
- id: researcher
  type: agent           # optional — inferred from "agent:" field
  agent: my-researcher
  task: >
    Research the codebase for: ${{task}}
    Focus on modules related to authentication.
  blockedBy: [project-context]
  inputs:
    project_context: ${{result.project-context.summary}}
  on_complete: reviewer   # optional — route to step on success
  on_error: error-handler  # optional — route to step on error
  output: research.md      # optional — output file hint
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. Used in `blockedBy`, `${{result.id.*}}`, and branch targets. |
| `agent` | Yes | Agent name from the catalog. |
| `task` | No | Task override. Template string. If omitted, agent uses its default system prompt with `${{task}}` expanded. |
| `blockedBy` | No | Array of step IDs that must complete before this step runs. Enforces DAG ordering. |
| `inputs` | No | Named inputs wired from template expressions. Each key becomes `${{input.KEY}}` in the agent's prompt. |
| `on_complete` | No | Step ID to route to on success. Causes a cross-segment jump. |
| `on_error` | No | Step ID to route to on error. |
| `output` | No | Output file path hint. |

**Same agent, multiple steps:** Give each step a unique `id`. The agent name can repeat.

```yaml
- id: first-draft
  agent: writer
  task: Write the initial draft.

- id: revised-draft
  agent: writer
  blockedBy: [first-draft]
  task: Revise based on feedback.
  inputs:
    draft: ${{result.first-draft.summary}}
```

---

#### 2. Fork step

Presents a choice to the user and routes to different steps based on the selection. In autonomous mode, the `agent:` field provides an agent to decide automatically.

```yaml
- id: choose-strategy
  type: fork
  question: Which implementation strategy should we use?
  options:
    - Fast path (minimal change)
    - Full refactor
    - Workaround
  branches:
    Fast path (minimal change): fast-impl
    Full refactor: refactor-impl
    Workaround: workaround-impl
  agent: flow-decision    # used in autonomous mode
  task: >
    Choose the best strategy based on: ${{result.analyzer.summary}}
  allowCustom: false      # optional — adds "Other (describe)" option
  multiSelect: false      # optional — allow selecting multiple options
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. |
| `question` | Yes | Question shown to the user (or agent in autonomous mode). Template string. |
| `options` | Yes | List of choice strings. |
| `branches` | Yes | Map of option text → target step ID. Keys must match options **exactly**. |
| `agent` | No | Agent for autonomous mode decisions and `allowCustom` freetext routing. |
| `task` | No | Context for the auto-deciding agent. Template string. |
| `allowCustom` | No | Appends an "Other (describe)" option. Requires `agent:` — the agent interprets freetext and routes to the closest branch. |
| `multiSelect` | No | Allow multiple selections. The selected options are joined and passed as context. |

**Fork context injection:** The chosen option, user notes, and decision source (user or agent) are automatically injected into the branch step's system prompt — no manual wiring needed.

---

#### 3. Conditional step

Binary branch based on whether a result field is empty or non-empty.

```yaml
- id: has-gaps
  type: conditional
  check: researcher.artifacts    # format: stepId.field
  present: gap-filler             # step ID if field has content
  absent: finalizer               # step ID if field is empty
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. |
| `check` | Yes | `stepId.field` — the field to check. Common fields: `summary`, `artifacts`, `files`, or any typed output name. |
| `present` | Yes | Step ID to route to if the field is non-empty. |
| `absent` | Yes | Step ID to route to if the field is empty or absent. |

No regex or value comparison — purely presence/absence.

---

#### 4. Agent decision step

An agent evaluates options and calls `finish({ branch: "chosen" })` to select the route.

```yaml
- id: complexity-check
  type: agent-decision
  agent: analyzer
  task: >
    Determine if this change is simple or complex.
    Research summary: ${{result.researcher.summary}}
  branches:
    simple: quick-path
    complex: thorough-path
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. |
| `agent` | Yes | Agent that makes the decision. |
| `task` | Yes | Context for the decision agent. Template string. |
| `branches` | Yes | Map of branch name → target step ID. |

The guard injects the branch names into the `finish` tool parameters as a union type. The agent must pick one of the declared branch names.

---

#### 5. Agent loop decision step

Iterative loop control. An agent decides to loop back or continue forward.

```yaml
- id: verify-loop
  type: agent-loop-decision
  agent: flow-decision
  task: >
    Evaluate verification result (iteration ${{loop.verify-loop.iteration}}/${{loop.verify-loop.max}}).
    Verifier output: ${{result.verifier.summary}}
    If all checks pass → "exit". If issues remain → "fixer".
  loop_target: fixer      # step to jump BACK to (must be an earlier step)
  exit_target: summarizer  # step to continue FORWARD to
  max_iterations: 3        # safety cap — forced exit when exceeded
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. |
| `agent` | Yes | Agent that evaluates loop/exit. Typically `flow-decision`. |
| `task` | Yes | Evaluation context. Template string. Include `${{loop.id.iteration}}` and `${{loop.id.max}}` for transparency. |
| `loop_target` | Yes | Step ID to jump **back** to. |
| `exit_target` | Yes | Step ID to continue **forward** to. |
| `max_iterations` | Yes | Safety cap. When exceeded, the engine forces the exit path without asking the agent. |

The agent calls `finish({ branch: "<loop_target>" })` to loop or `finish({ branch: "<exit_target>" })` to exit.

**Typical verify/fix loop:**
```yaml
- id: implement
  agent: implementer
  task: Implement the feature.

- id: verify
  agent: verifier
  blockedBy: [implement]
  task: Run tests and verify the implementation.

- id: should-fix
  type: agent-loop-decision
  agent: flow-decision
  task: >
    Iteration ${{loop.should-fix.iteration}}/${{loop.should-fix.max}}.
    Verification: ${{result.verify.summary}}
    Choose "fixer" if failures remain, "done" if all pass.
  loop_target: fixer
  exit_target: done
  max_iterations: 3

- id: fixer
  agent: implementer
  task: Fix the failing tests identified by the verifier.
  inputs:
    test_output: ${{result.verify.summary}}
  on_complete: verify    # jump back to verify after fix

- id: done
  agent: summarizer
  task: Summarize the completed implementation.
```

---

#### 6. Flow reference step

Delegate execution to another flow file, optionally using a glob pattern.

```yaml
- id: run-sub-flow
  type: flow-ref
  path: "project/changes/*/exec.yaml"    # glob supported
  on_complete: verify
  on_error: error-handler
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. |
| `path` | Yes | Absolute or relative path to a `.yaml` flow file. Glob patterns match multiple files (executed sequentially). |
| `on_complete` | No | Step ID to route to on success. |
| `on_error` | No | Step ID to route to on error. |

Sub-flow results are merged into the parent context under the sub-flow's agent step IDs.

---

### Template variables

Template expressions `${{...}}` are expanded in `task`, `inputs` values, `question`, and `agent-loop-decision.task`. They are **not** validated at parse time — a typo silently resolves to an empty string.

| Variable | Resolves to |
|----------|------------|
| `${{task}}` | The original user task string (from command args or `task_required` prompt). |
| `${{input.NAME}}` | Named input passed to this step via the `inputs:` block. |
| `${{result.STEP_ID.status}}` | Step result status: `"complete"`, `"error"`, `"blocked"`, `"unknown"`. |
| `${{result.STEP_ID.summary}}` | Summary string from the step's `finish` call. |
| `${{result.STEP_ID.artifacts}}` | Raw artifacts XML from the step. |
| `${{result.STEP_ID.files}}` | Comma-separated list of files created/modified. |
| `${{result.STEP_ID.fullOutput}}` | Full raw output text. Use sparingly — can be very large. |
| `${{result.STEP_ID.OUTPUTNAME}}` | Typed output declared in agent's `outputs:` frontmatter. |
| `${{loop.STEP_ID.iteration}}` | Current iteration count of a loop decision step. |
| `${{loop.STEP_ID.max}}` | Max iterations configured for a loop decision step. |

**Note:** `STEP_ID` in result references is the step's `id` field, not the agent name.

---

### Input wiring

Inputs are the mechanism for passing data between steps. An agent declares what it expects (`inputs:` in frontmatter); a flow step wires the values (`inputs:` in the step).

```yaml
# Step that produces data
- id: researcher
  agent: researcher
  task: Research the codebase.

# Step that consumes researcher's output
- id: implementer
  agent: implementer
  blockedBy: [researcher]
  inputs:
    research_context: ${{result.researcher.summary}}
    project_root: ${{result.researcher.artifacts}}
```

In the implementer's system prompt:
```markdown
---
inputs:
  - research_context
  - project_root
---
Use this context: ${{input.research_context}}
Working in: ${{input.project_root}}
```

---

### File content injection

Prefix an input value with `file://` to inject file content directly into the agent's prompt at dispatch time.

```yaml
- id: validator
  agent: validator
  inputs:
    spec_content: file://specs/api-spec.md
    output_content: file://${{result.generator.files}}
```

Rules:
- `file://${{result.STEP.files}}` — only use when the step produces exactly **one** file (the `files` field is comma-separated for multiple files).
- File content is injected **verbatim** — never template-expanded.
- The step whose file is referenced must be in `blockedBy`.
- If the file does not exist at dispatch time, the step fails with an error.

---

### Multiline task text

```yaml
- id: researcher
  agent: researcher
  task: >
    Research the codebase for context on: ${{task}}

    Focus on:
    - Authentication patterns
    - Database schema
    - Existing test coverage

  # Alternative: literal block (preserves newlines exactly)
  # task: |
  #   Line 1
  #   Line 2
```

- `>` (folded scalar) — joins consecutive lines with spaces; blank lines become newlines.
- `|` (literal scalar) — preserves every newline exactly.

---

## Discovery conventions

| Content | Location | Pattern |
|---------|----------|---------|
| Built-in agents | `pi-flows/agents/` | `*.md` (non-recursive) |
| Project-local agents | `.pi/flows/agents/` | `*.md` (non-recursive) |
| Package agents | Registered via `flow:register-agents-dir` | `*.md` |
| Built-in flows | `pi-flows/flows/` | `**/*.yaml` (1 subfolder deep) |
| Project-local flows | `.pi/flows/flows/` | `**/*.yaml` (1 subfolder deep) |
| Package flows | Registered via `flow:register-flows-dir` | `**/*.yaml` |
| Skills | Registered via `flow:register-skills-dir` | `<name>/SKILL.md` |

**Override priority (highest to lowest):**
1. Project-local (`.pi/flows/`)
2. Package (registered via events)
3. pi-flows built-ins
