# Flow Reference

Complete reference for authoring flows in pi-flows. Covers all step types with syntax, field references, and practical examples.

---

## Flow File Format

Flows are `.yaml` files with YAML frontmatter followed by step definitions. Each step has a unique `id` and is connected to other steps via `blockedBy` declarations to form a directed acyclic graph (DAG).

**Location:** `.pi/flows/flows/<name>.yaml` or a package-registered flows directory.

---

## Flow Frontmatter

```yaml
---
name: research-and-build
description: Research the codebase then implement changes
max_concurrent: 2
task_required: true
task_prompt: "What feature should I research and implement?"
config:
  package_manager: pnpm
  node_env: production
---
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `name` | ✓ | Flow identifier — for documentation; the slash command is derived from the file path |
| `description` | ✓ | What the flow does (shown in command list and dashboard) |
| `max_concurrent` | | Maximum agents running in parallel (default: `4`) |
| `task_required` | | When `true`, prompts the user for a task if none was provided |
| `task_prompt` | | Custom prompt text shown when asking for a task |
| `config` | | Key-value config map. Values accessible as `${{config.key}}` in shell step commands. Overrides global `.pi/flows/config.yaml`. |

> **Command name = file path, not `name:` field.** The slash command is derived from the file path:
>
> | File path | Command |
> |-----------|---------|
> | `.pi/flows/flows/research.yaml` | `/research` |
> | `.pi/flows/flows/my-domain/apply.yaml` | `/my-domain:apply` |

---

## Step Types

Steps form a DAG based on `blockedBy` declarations. pi-flows schedules steps that have no pending dependencies in parallel, respecting `max_concurrent`.

### Agent Step (default)

Dispatches a named agent with a task. This is the most common step type.

**Syntax:**

```yaml
steps:
  - id: my-step
    agent: agent-name
    task: Optional task override with ${{template}} variables
    blockedBy: [step-a, step-b]
    inputs:
      input_name: "${{result.step-a.summary}}"
    on_complete: next-step
    on_error: error-handler
```

**Field reference:**

| Field | Description |
|-------|-------------|
| `id` | **Required.** Unique step identifier |
| `agent` | **Required.** Agent name to dispatch |
| `task` | Task override (template string). If omitted, uses the flow's task |
| `blockedBy` | Array of step IDs that must complete before this step starts |
| `inputs` | Named inputs wired from template expressions |
| `on_complete` | Step ID to route to on success |
| `on_error` | Step ID to route to on error |

**Example — parallel research with fan-in:**

```yaml
name: multi-research
description: Research multiple domains in parallel

steps:
  - id: backend-research
    agent: researcher
    task: Investigate backend patterns for ${{task}}

  - id: frontend-research
    agent: researcher
    task: Investigate frontend patterns for ${{task}}

  - id: synthesizer
    agent: synthesizer
    blockedBy: [backend-research, frontend-research]
    inputs:
      backend: "${{result.backend-research.summary}}"
      frontend: "${{result.frontend-research.summary}}"
    task: Synthesize findings from both research passes
```

---

### Fork Step

Pause execution and present options to the user. The selected option determines which branch runs.

**Syntax:**

```yaml
  - id: choose-approach
    type: fork
    question: "Which approach do you prefer?"
    options: [Quick fix, Full refactor]
    branches:
      Quick fix: quick-fix-step
      Full refactor: refactor-step
    allowCustom: true
    agent: router-agent
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `question` | ✓ | Question displayed to the user |
| `options` | ✓ | Comma-separated or YAML list of choices |
| `branches` | ✓ | Map of option text → step ID |
| `allowCustom` | | Appends "Other (describe)" option. Custom freetext routes through the fork's `agent`. Requires `agent`. |
| `multiSelect` | | Allow selecting multiple options. All selected branches run sequentially. |
| `agent` | | Agent for autonomous decisions (Ctrl+A) and custom freetext routing. Required when `allowCustom` is set. |
| `task` | | Task description for the decision agent. Defaults to question + options. |

**Behavior:**

- **Single-select:** Routes to one branch. Unselected branches are skipped (synthetic "skipped" results stored).
- **Multi-select:** Multiple branches run in parallel.
- **After selection:** User is prompted for optional notes (Enter to skip). Fork context is **automatically injected** into the branch step's system prompt.

**Autonomous mode:** When Ctrl+A is active, fork steps with an `agent:` field skip the user prompt and let the agent decide automatically. Forks without `agent:` always prompt the user.

---

### Conditional Step

Branch based on whether a field from a previous step's result is non-empty.

**Syntax:**

```yaml
  - id: check-research
    type: conditional
    check: researcher.artifacts
    present: process-artifacts
    absent: skip-to-build
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `check` | ✓ | `stepId` or `stepId.field` to check. Field defaults to `artifacts` if omitted. |
| `present` | ✓ | Step ID to route to if the field is non-empty |
| `absent` | ✓ | Step ID to route to if the field is empty or the step has no result |

**Supported fields:**

| Field | Checks |
|-------|--------|
| `artifacts` | The `<artifacts>` block from `finish` (default) |
| `summary` | The `<summary>` from `finish` |
| `files` | The files list from `finish` |
| `status` | The status field (`"complete"`, `"error"`, etc.) |

---

### Agent Decision Step

Delegate a routing decision to an agent. The agent analyzes the context and calls `finish` with a `branch` name.

**Syntax:**

```yaml
  - id: route-decision
    type: agent-decision
    agent: router-agent
    task: "Review and decide: ${{result.analyzer.summary}}"
    branches:
      needs-work: fix-step
      ready: deploy-step
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `agent` | ✓ | Agent name — must call `finish` with a valid `branch` |
| `task` | ✓ | Task for the decision agent. Supports template variables. |
| `branches` | ✓ | Map of branch names → step IDs |

**Agent finish call:**

```
finish(summary="Quality is sufficient.", branch="ready")
```

If the agent returns a `branch` not in `branches`, the flow errors.

---

### Agent Loop Decision Step

Iterative verify/fix cycles. The agent decides on each iteration whether to loop back or exit.

**Syntax:**

```yaml
  - id: verify-loop
    type: agent-loop-decision
    agent: verifier
    task: "Check iteration ${{loop.verify-loop.iteration}}/${{loop.verify-loop.max}}: ${{result.developer.summary}}"
    loop_target: developer
    exit_target: finalize
    max_iterations: 3
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `agent` | ✓ | Decision agent — calls `finish(branch:)` with `loop_target` or `exit_target` |
| `task` | ✓ | Task for the decision agent. Supports loop template variables. |
| `loop_target` | ✓ | Step ID to jump back to for more work |
| `exit_target` | ✓ | Step ID to continue to when satisfied |
| `max_iterations` | ✓ | Safety cap — forces exit when exceeded |

**How the agent decides:**

```
# Continue looping:
finish(summary="Tests still failing.", branch="developer")

# Exit the loop:
finish(summary="All tests passing.", branch="finalize")
```

The `branch` value must exactly match either `loop_target` or `exit_target`.

**Full loop example:**

```yaml
steps:
  - id: developer
    agent: developer
    task: Implement ${{task}}

  - id: verify-loop
    type: agent-loop-decision
    agent: verifier
    task: >
      Check implementation (attempt ${{loop.verify-loop.iteration}}/${{loop.verify-loop.max}}).
      Developer output: ${{result.developer.summary}}
    loop_target: developer
    exit_target: finalize
    max_iterations: 3

  - id: finalize
    agent: summarizer
    task: Summarize the completed implementation
```

---

### Shell Step

Run a shell command directly within a flow. No agent is dispatched — the command executes immediately and the result is stored like any other step result.

**Syntax:**

```yaml
  - id: build
    type: shell
    command: "${{config.package_manager}} run build"
    timeout: 300
    config:
      package_manager: yarn    # per-step override
    on_complete: test
    on_error: notify
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `id` | ✓ | Unique step identifier |
| `command` | ✓ | Shell command to run. Template string — supports `${{config.key}}`, `${{task}}`, `${{result.X.field}}`. |
| `timeout` | | Seconds before the command is killed. Default: `1800` (30 min). Routes to `on_error` on timeout. |
| `config` | | Per-step config overrides. Merged on top of flow-level and global config. |
| `on_complete` | | Step ID to route to when exit code is `0`. |
| `on_error` | | Step ID to route to on non-zero exit code or timeout. |

**Execution:**
- Runs as `sh -c "<command>"` from the project root.
- stdout is captured as the step output; stderr is captured separately.
- Downstream steps access output via `${{result.build.output}}` (stdout), `${{result.build.status}}` (`complete` or `error`).

**Config system (3-layer resolution, highest wins):**
1. Per-step `config:` on the shell step
2. Flow-level `config:` at the top of the flow YAML
3. Global `.pi/flows/config.yaml` in the project root

**Global config file (`.pi/flows/config.yaml`):**

```yaml
package_manager: pnpm
node_env: production
```

**Example — CI pipeline with configurable package manager:**

```yaml
name: ci
description: Build, test, and deploy
config:
  package_manager: pnpm

steps:
  - id: build
    type: shell
    command: "${{config.package_manager}} run build"
    on_complete: test
    on_error: notify

  - id: test
    type: shell
    command: "${{config.package_manager}} run test"
    on_complete: report
    on_error: notify

  - id: report
    agent: reporter
    task: "Build: ${{result.build.status}}, Tests: ${{result.test.status}}"

  - id: notify
    agent: notifier
    task: "Step failed. Build: ${{result.build.output}}, Tests: ${{result.test.output}}"
```

---

### Flow Reference Step

Delegate execution to another flow file. The sub-flow runs to completion before continuing.

**Syntax:**

```yaml
  - id: run-tests
    type: flow-ref
    path: .pi/flows/flows/test-suite.yaml
    on_complete: deploy-step
    on_error: fix-step
```

**Field reference:**

| Field | Description |
|-------|-------------|
| `path` | **Required.** Path to the sub-flow `.yaml` file |
| `on_complete` | Step ID to route to after sub-flow completes |
| `on_error` | Step ID to route to if sub-flow errors |

**Result propagation:**
- Sub-flow agent results are flat-merged into the parent's result context
- The flow-ref step ID stores the last agent's result
- Downstream steps can reference sub-flow agents: `${{result.sub-agent-id.summary}}`

---

## Template Variable Reference

Template variables are placeholders in `task`, `inputs`, and `question` fields. They are expanded just before an agent is dispatched.

| Variable | Resolves To |
|----------|-------------|
| `${{task}}` | The task passed when the flow was invoked |
| `${{input.NAME}}` | A wired input value (from the `inputs:` block) |
| `${{config.KEY}}` | A config value — resolved from per-step → flow-level → global `.pi/flows/config.yaml` |
| `${{result.STEP-ID}}` | Full raw output from a completed step |
| `${{result.STEP-ID.summary}}` | Summary from `finish(summary:)` |
| `${{result.STEP-ID.status}}` | Status: `complete`, `error`, or `blocked` |
| `${{result.STEP-ID.artifacts}}` | The `<artifacts>` XML block from `finish` |
| `${{result.STEP-ID.files}}` | Comma-separated file paths created/modified |
| `${{result.STEP-ID.<outputName>}}` | A typed output from the agent's `outputs:` declaration |
| `${{loop.STEP-ID.iteration}}` | Current iteration (1-based) in a loop step |
| `${{loop.STEP-ID.max}}` | Maximum iterations configured for a loop |

> **Resolution order:** Variables are expanded at dispatch time. `${{result.X}}` is only valid if step `X` has already completed (guaranteed when `X` is in `blockedBy`).

> **Missing values resolve to empty string.** Referencing an unrun step, undeclared input, or non-existent field becomes `""`.

---

## Input Wiring

Inputs wire specific data from one step to another as named variables, separate from the task text.

### Declare on the agent

```yaml
# agents/developer.md
inputs:
  - research_output
  - ticket_context
```

### Wire in the flow step

```yaml
  - id: developer
    agent: developer
    blockedBy: [researcher]
    inputs:
      research_output: "${{result.researcher.summary}}"
      ticket_context: "${{result.ticket-fetch.artifacts}}"
```

### Reference in the system prompt

```markdown
Research context:
${{input.research_output}}

Ticket context:
${{input.ticket_context}}
```

If `inputs:` is not declared in the agent's frontmatter, the input values are substituted but the system prompt has no `${{input.NAME}}` to expand them into.

### File Content Injection (`file://` prefix)

When an agent needs the **content** of a file (not just a path), use the `file://` prefix:

```yaml
  - id: validate
    agent: validator
    blockedBy: [researcher]
    inputs:
      report: file://research/findings.md
```

**Dynamic path from previous step:**

```yaml
  - id: summarize
    agent: summarizer
    blockedBy: [writer]
    inputs:
      report: file://${{result.writer.files}}
```

**Rules:**
- The producing step **MUST** be in `blockedBy` so the file exists at dispatch time
- File content is injected **verbatim** (never template-expanded)
- If the file doesn't exist, the step fails with a clear error

---

## Common Flow Patterns

### Research → Plan → Execute

```yaml
name: research-and-build
description: Research, plan, then implement

steps:
  - id: research
    agent: researcher
    task: Investigate the codebase for ${{task}}

  - id: planner
    agent: planner
    blockedBy: [research]
    task: Create an implementation plan based on: ${{result.research.summary}}

  - id: implementer
    agent: developer
    blockedBy: [planner]
    inputs:
      plan: "${{result.planner.summary}}"
    task: Implement the plan. Details: ${{input.plan}}
```

### Interactive Branching

```yaml
name: flexible-workflow
description: User-driven workflow selection

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
    task: Quick scan of ${{task}}

  - id: deep
    agent: deep-analyzer
    task: Deep analysis of ${{task}}

  - id: report
    agent: reporter
    blockedBy: [quick, deep]
    task: Generate report from analysis results
```

### Verify-Fix Loop

```yaml
name: implement-and-verify
description: Implement with verification loop

steps:
  - id: implement
    agent: developer
    task: Implement ${{task}}

  - id: verify
    agent: verifier
    blockedBy: [implement]
    task: Verify the implementation

  - id: verify-loop
    type: agent-loop-decision
    agent: flow-decision
    task: "Evaluate: ${{result.verify.summary}}"
    loop_target: implement
    exit_target: done
    max_iterations: 3

  - id: done
    agent: summarizer
    task: Summarize the completed work
```
