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
---
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `name` | ✓ | Flow identifier — for documentation; the slash command is derived from the file path |
| `description` | ✓ | What the flow does (shown in command list and dashboard) |
| `max_concurrent` | | Maximum agents running in parallel (default: `4`) |
| `task_required` | | When `true`, prompts the user for a task if none was provided |
| `task_prompt` | | Custom prompt text shown when asking for a task |

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

## Failure Modes

Every node in a flow resolves to exactly **one** of three outcomes. The outcome decides where the flow goes next.

| Outcome | Meaning | Routing |
|---------|---------|---------|
| `success` | The node completed its work | Routes to the node's `on_complete` |
| `soft` | A recoverable failure — the node ran but reported a logical problem | Routes to the node's `on_error` |
| `hard` | An unrecoverable failure | Aborts in-flight parallel steps, skips all pending steps, and ends the flow with status `error`, surfacing the failure message |

```mermaid
flowchart TD
  N[Node runs] --> O{Outcome?}
  O -->|success| C[on_complete]
  O -->|soft| E{on_error declared?}
  E -->|yes| H[on_error]
  E -->|no| HF[Hard-fail the flow]
  O -->|hard| HF
  HF --> A[Abort in-flight steps<br/>skip pending steps<br/>flow status = error]
```

### `on_error` is the soft switch

A soft-eligible failure routes to `on_error` **when the node declares one**. A soft-eligible failure on a node with **no `on_error` hard-fails the flow**. This is fail-fast by default: if you do not handle a recoverable failure, the flow stops rather than silently continuing.

> **⚠️ Breaking behavioral change.** Previously, a failure on a node with no `on_error` silently continued. It now **hard-fails the flow**. Flows that relied on silent continuation must add an explicit `on_error` target to the affected node.

### How agent failures are classified

Agent outcomes are determined **structurally** — there is no error-message parsing and no deliberate "fatal" signal from the agent.

| Agent end state | Outcome |
|-----------------|---------|
| `finish(status:"complete")` | `success` |
| `finish(status:"error")` or `finish(status:"blocked")` | `soft` (the agent ran and reported a logical failure) |
| Terminated with a terminal API error and no `finish` (pi-coding-agent's auto-retries exhausted: rate limit, quota, auth) | `hard` (the provider is unusable for the rest of the flow) |
| Terminated without finishing and without an API error | `soft` |

**Capped no-finish reminder.** If an agent stops without calling `finish` (and there is no API error), it receives at most **2** reminders that include the `finish` tool-call format. If it still does not finish, the node resolves as a clean `soft` failure — never `status:"unknown"`, and never an infinite loop.

### Transient retries are delegated to pi

pi-coding-agent already auto-retries transient errors (rate limit, 5xx, overloaded, network, timeout) with exponential backoff. pi-flows adds **no** redundant retry layer. By the time an error reaches the flow engine, it is terminal.

### Code and extension nodes

For nodes implemented in code (extensions), the thrown error decides the outcome:

| Thrown | Outcome |
|--------|---------|
| A plain `throw` (any `Error`) | `soft` failure — routes to `on_error` if declared, otherwise hard-fails |
| `throw new FlowHardError(msg)` | **Unconditional** `hard` failure — stops the flow regardless of `on_error` |

`FlowHardError` is exported from the package. See [public-api.md](./public-api.md) for its shape and usage.

---

## Template Variable Reference

Template variables are placeholders in `task`, `inputs`, and `question` fields. They are expanded just before an agent is dispatched.

| Variable | Resolves To |
|----------|-------------|
| `${{task}}` | The task passed when the flow was invoked |
| `${{input.NAME}}` | A wired input value (from the `inputs:` block) |
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
