# Flow Authoring Reference

Complete reference for the agent `.md` and flow `.yaml` file formats. Covers every frontmatter field, all step types with syntax and examples, the template variable system, and the `finish` result envelope agents must produce.

---

## Agent File Format

Agents are Markdown files with a YAML frontmatter block followed by the system prompt body. The frontmatter configures how the agent is dispatched; the body is the prompt the agent receives.

**Location:** `.pi/flows/agents/<name>.md` or a package-registered agents directory.

### Complete frontmatter reference

```yaml
---
name: backend-developer
description: Implements backend changes based on research findings
model: @coding
thinking: high
tools: read, write, edit, bash, grep, skill_read
skills: my-backend-docs
context:
  - docs/architecture.md
  - config/api-spec.json
inputs:
  - research_output
  - ticket_id
output: implementation-result.md
interactive: false
access:
  read:
    - "src/**"
    - "tests/**"
  write:
    - "src/**"
    - "tests/**"
  bash:
    deny:
      - "rm -rf *"
      - "curl *"
      - "sudo *"
card:
  label: "Developer"
  metric: "developer"
architect:
  use_when: "When backend code changes are needed"
  produces: "Modified source files with tests"
  depends_on: "Research findings and ticket context"
  domain: "development"
---

You are a backend developer. Your task: ${{task}}

Use the research context provided:
${{input.research_output}}

Reference ticket: ${{input.ticket_id}}

Focus on clean, tested implementations. Run the existing test suite after changes.
```

### Field reference

| Field | Required | Type | Description |
|-------|:--------:|------|-------------|
| `name` | ✓ | string | Unique identifier. Used in flow steps (`agent: name`) and the `subagent` tool. Must be unique across all registered agents. |
| `description` | ✓ | string | Short description. Shown in the Flow Architect and `/catalog`. |
| `model` | ✓ | string | Model role (`@coding`, `@planning`, etc.) or direct model ID (`claude-sonnet-4-20250514`). Roles are resolved from the user's `/roles` config. |
| `thinking` | | string | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Activates extended reasoning on supported models. |
| `tools` | ✓ | csv or list | Tools the agent can call. See [Available Tools](#available-tools). `finish` is auto-injected — do not declare it. |
| `skills` | | csv or list | Skill names to inject into this agent's system prompt. Each skill must exist in a registered skills directory. |
| `context` | | yaml list | File paths (relative to project root) injected as read-only context before the agent's first turn. |
| `inputs` | | yaml list | Declared input names. These become `${{input.NAME}}` variables in the system prompt. Must be wired in the flow step's `inputs:` block. |
| `output` | | string | Default output filename (written by the agent). Overridable per step. |
| `interactive` | | boolean | If `true`, the agent can call `ask_user` to prompt the user mid-execution. Default: `false`. |
| `access` | | block | Sandboxing rules. Restricts `read`, `write`, and `bash`. See [Access Control](#access-control). |
| `card` | | block | Dashboard card display configuration. See [Dashboard Cards](#dashboard-cards). |
| `architect` | | block | Metadata for the Flow Architect LLM. Helps it understand when and how to use this agent. |

### Model reference formats

```yaml
model: @coding                          # Role alias — resolved via /roles
model: claude-sonnet-4-20250514         # Direct model ID
model: claude-sonnet-4-20250514:high    # Direct model ID with thinking suffix
```

Role aliases (`@planning`, `@coding`, `@fast`, `@research`, `@compact`, `@vision`) are resolved from the user's role assignments at dispatch time. If no model is assigned to the role, the agent fails with a clear error.

### Available tools

Declare these in the `tools:` field. Tools not listed are unavailable to the agent.

| Name | Description |
|------|-------------|
| `read` | Read file contents (text and images) |
| `write` | Write or create files |
| `edit` | Surgical text replacement in existing files |
| `bash` | Execute shell commands |
| `grep` | Search file contents with regex (supports `glob:` filter) |
| `find` | Find files in directory trees (supports glob patterns) |
| `ls` | List directory contents |
| `skill_read` | Read detail files from declared skills |

> **`finish` is automatic.** Never declare it. Every agent session has `finish` auto-injected. Agents *must* call `finish` as their last action.

> **Extension tools** (e.g., `model_cli`) registered by packages via `flow:register-tool` can also be declared here.

> **Do not declare** `subagent`, `ask_user` (unless `interactive: true`), or any architect tools (`agent_catalog`, `flow_validate`, etc.) — they are blocked in agent subprocesses.

### Access control

```yaml
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
      - "sudo *"
```

- **`read`** — Glob patterns for allowed read paths. Reads outside these paths are blocked.
- **`write`** — Glob patterns for allowed write paths. Writes outside are blocked.
- **`bash.deny`** — Shell command patterns to block. Matched against the full command string.

If `access` is omitted entirely, no restrictions apply.

### Dashboard cards

```yaml
card:
  label: "Developer"     # Display label shown on the card
  metric: "developer"    # Metric type — matches a registered AgentCardRenderer
```

Built-in metric types: `default` (no metric line), `files` (counts file edits), `tests` (counts test results).

Custom metric types are registered by packages via `flow:register-card`. See [events-api.md](events-api.md#flowregister-card).

### Architect metadata

```yaml
architect:
  use_when: "When backend code changes are needed"
  produces: "Modified source files and tests"
  depends_on: "Research summary and feature spec"
  domain: "development"
```

These fields are consumed by the Flow Architect agent when generating flows. They help the architect choose appropriate agents and sequence them correctly. All fields are optional but improve flow quality.

### System prompt body

The body below the second `---` is the agent's system prompt. It supports template variables:

```markdown
---
name: developer
...
---

You are a backend developer. Your task: ${{task}}

Research context:
${{input.research_output}}

Your job is to implement the feature described in the task. Follow the existing code style.
Call `finish` when done with a summary of what you changed.
```

Template variables in the body are expanded when the agent is dispatched — they are resolved against the flow's execution context at that point. See the [Template Variable Reference](#template-variable-reference) below.

---

## Flow File Format

Flows are `.yaml` files with YAML frontmatter and `##`-delimited step sections. The file defines a pipeline of steps that form a directed acyclic graph (DAG) via `blockedBy` declarations.

**Location:** `.pi/flows/flows/<name>.yaml` or a package-registered flows directory.

### Flow frontmatter

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
| `name` | ✓ | Used for documentation. The actual slash command derives from the file path, not this field. |
| `description` | ✓ | Shown in the command list and dashboard header. |
| `max_concurrent` | | Maximum agents running in parallel. Default: `4`. Use `1` to force sequential execution. |
| `task_required` | | When `true`, pi-flows prompts the user for a task if they invoke the command without arguments. |
| `task_prompt` | | Custom prompt text shown when asking for a task. Default: `"Describe what you want <name> to do:"`. |

> **Command naming.** The slash command is derived from the file path, not the `name:` field:
>
> | File path | Command |
> |-----------|---------|
> | `.pi/flows/flows/research.yaml` | `/research` |
> | `.pi/flows/flows/judo/apply.yaml` | `/judo:apply` |
>
> Keep `name:` in sync with the file path for clarity, but pi-flows always uses the filesystem-derived name.

---

## Step Types

Steps are `##`-delimited sections in the flow body. The `##` header determines the step type and ID:

| Header syntax | Step type |
|---------------|-----------|
| `## step-id` | Agent step (default) |
| `## fork: step-id` | Fork step |
| `## conditional: step-id` | Conditional step |
| `## agent-decision: step-id` | Agent decision step |
| `## agent-loop-decision: step-id` | Agent loop decision step |
| `## flow-ref: path/to/flow.yaml` | Flow reference step |

---

### Agent Steps

Dispatches a named agent with an optional task override. This is the most common step type.

**Syntax:**

```markdown
## step-id
agent: agent-name
task: Optional task override. Supports ${{template}} variables.
model: @fast                     # optional model override for this step only
blockedBy: other-step, another   # comma-separated step IDs
inputs:
  input_name: "${{result.other-step.summary}}"
output: result-file.md           # optional output filename override
reads:                           # files to inject as context before execution
  - docs/spec.md
on_complete: next-step           # route to this step on success
on_error: error-handler          # route to this step on failure
```

**Field reference:**

| Field | Description |
|-------|-------------|
| `agent` | **Required.** Agent name to dispatch. Must exist in the agent registry. |
| `task` | Task override. If omitted, uses the flow's task (`${{task}}`). Supports template variables. |
| `model` | Override the agent's `model` field for this step only. |
| `blockedBy` | Comma-separated step IDs that must complete before this step starts. |
| `inputs` | Named input values wired from template expressions. See [Input Wiring](#input-wiring). |
| `output` | Override the agent's default output filename. |
| `reads` | File paths injected as read-only context before the agent's first turn. |
| `on_complete` | Step ID to route to after this step succeeds. |
| `on_error` | Step ID to route to if this step errors. |

**Example — parallel research with sequential development:**

```markdown
---
name: research-and-build
description: Research then implement
---

## researcher
agent: researcher
task: Investigate the codebase for ${{task}}

## summarizer
agent: summarizer
task: Summarize the test coverage

## developer
agent: developer
blockedBy: researcher, summarizer
inputs:
  research: "${{result.researcher.summary}}"
  coverage: "${{result.summarizer.summary}}"
task: Implement ${{task}} based on research

## verifier
agent: verifier
blockedBy: developer
task: Verify the implementation is correct
```

`researcher` and `summarizer` run in parallel. `developer` starts only after both complete. `verifier` runs last.

**Reusing the same agent for multiple steps:**

Give each instance a unique step ID:

```markdown
## draft
agent: writer
task: Write initial draft

## revise
agent: writer
blockedBy: draft
task: Revise based on feedback: ${{result.draft.summary}}
```

---

### Fork Steps

Pause execution and present the user with a choice. The selected option determines which branch runs next.

**Syntax:**

```markdown
## fork: choose-approach
question: Which approach do you prefer?
options: Quick fix, Full refactor
branches:
  Quick fix: quick-fix-step
  Full refactor: refactor-step
allowNotes: true
allowCustom: false
multiSelect: false
agent: router-agent
task: Choose the approach based on the technical context
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `question` | ✓ | Question displayed to the user |
| `options` | ✓ | Comma-separated or YAML list of choices |
| `branches` | ✓ | Map of option text → step ID. Must cover all options. |
| `allowNotes` | | If `true`, prompts for optional freetext notes after selection. Notes accessible via `${{fork.ID.notes}}`. |
| `allowCustom` | | Deprecated — use `allowNotes`. Adds "Other (describe)" option. |
| `multiSelect` | | Allow selecting multiple options. All selected branches run sequentially. |
| `agent` | | Agent to use when autonomous mode is active (Ctrl+A). If absent, always prompts. |
| `task` | | Context passed to the autonomous agent. Defaults to the question + options. |

**Template variable access:**

```yaml
# In downstream steps:
task: "User chose: ${{fork.choose-approach.answer}}"
task: "Notes: ${{fork.choose-approach.notes}}"
```

**Autonomous mode:** When the user presses Ctrl+A (enabling `🤖 auto` in the footer), fork steps that have an `agent:` field skip the user prompt and let the named agent decide the branch automatically. Fork steps without `agent:` always prompt the user, even in autonomous mode.

---

### Conditional Steps

Branch based on whether a field from a previous step's result contains data.

**Syntax:**

```markdown
## conditional: check-artifacts
check: researcher.artifacts
present: process-artifacts
absent: skip-to-build
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `check` | ✓ | `stepId` or `stepId.field` to inspect. Field defaults to `artifacts` if omitted. |
| `present` | ✓ | Step ID to route to when the field is non-empty |
| `absent` | ✓ | Step ID to route to when the field is empty or the step has no result |

**Supported fields for `check`:**

| Field | Checks |
|-------|--------|
| `artifacts` | The `<artifacts>` block from `finish` |
| `summary` | The `<summary>` from `finish` |
| `files` | The files list from `finish` |
| `status` | The status field (`"complete"`, `"error"`, etc.) |

**Example:**

```markdown
## researcher
agent: researcher
task: Look for existing API docs

## conditional: has-docs
check: researcher.artifacts
present: use-existing-docs
absent: create-new-docs

## use-existing-docs
agent: developer
task: Extend existing API: ${{result.researcher.artifacts}}

## create-new-docs
agent: developer
task: Create new API documentation from scratch
```

---

### Agent Decision Steps

Delegate a routing decision to an agent. The agent analyzes the flow context and calls `finish` with a `branch` name to select the next step.

**Syntax:**

```markdown
## agent-decision: route-next
agent: router-agent
task: "Review the analysis and decide: ${{result.analyzer.summary}}"
branches:
  needs-work: fix-step
  ready: deploy-step
  escalate: human-review-step
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `agent` | ✓ | Agent name — must call `finish` with a valid `branch` name |
| `task` | ✓ | Task for the decision agent. Supports template variables. |
| `branches` | ✓ | Map of branch names → step IDs. The agent's `finish(branch:)` must match a key. |

The decision agent's `finish` call:

```
finish(summary="Quality is sufficient.", branch="ready")
```

If the agent returns a `branch` value not in `branches`, the flow errors.

---

### Agent Loop Decision Steps

Iterative verify/fix cycles. On each iteration, the agent decides whether to loop back for more work or exit forward.

**Syntax:**

```markdown
## agent-loop-decision: verify-loop
agent: verifier
task: "Check iteration ${{loop.verify-loop.iteration}}/${{loop.verify-loop.max}}: ${{result.developer.summary}}"
loop_target: developer
exit_target: finalize
max_iterations: 3
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `agent` | ✓ | Decision agent — calls `finish(branch:)` with `loop_target` or `exit_target` step ID |
| `task` | ✓ | Task for the decision agent. Supports loop template variables. |
| `loop_target` | ✓ | Step ID to jump back to when the agent decides more work is needed |
| `exit_target` | ✓ | Step ID to continue to when the agent is satisfied |
| `max_iterations` | ✓ | Safety cap — forces exit to `exit_target` when exceeded |

**How the agent decides:**

```
# To continue looping:
finish(summary="Tests still failing on auth module.", branch="developer")

# To exit the loop:
finish(summary="All tests passing.", branch="finalize")
```

The `branch` value must exactly match either `loop_target` or `exit_target`.

**Loop template variables:**

```yaml
task: "Iteration ${{loop.verify-loop.iteration}} of ${{loop.verify-loop.max}}: ..."
```

**Full loop example:**

```markdown
## developer
agent: developer
task: Implement ${{task}}

## verify-loop
agent: verifier
task: >
  Check implementation (attempt ${{loop.verify-loop.iteration}}/${{loop.verify-loop.max}}).
  Developer output: ${{result.developer.summary}}
loop_target: developer
exit_target: finalize
max_iterations: 3

## finalize
agent: summarizer
task: Summarize the completed implementation
```

---

### Flow Reference Steps

Delegate execution to another flow file. The sub-flow runs to completion before the parent flow continues.

**Syntax:**

```markdown
## flow-ref: .pi/flows/flows/sub-flow.yaml
on_complete: next-step
on_error: error-handler
```

The `##` header text IS the path — there is no separate `path:` field. The path is the full or relative path to the `.yaml` file.

**Field reference:**

| Field | Description |
|-------|-------------|
| `on_complete` | Step ID to route to after the sub-flow completes |
| `on_error` | Step ID to route to if the sub-flow errors |

---

## Template Variable Reference

Template variables are placeholders in `task`, `inputs`, `question`, and system prompt text. They are expanded just before an agent is dispatched.

| Variable | Resolves To |
|----------|-------------|
| `${{task}}` | The task string passed when the flow was invoked |
| `${{input.NAME}}` | A wired input value for this step (from the `inputs:` block) |
| `${{result.STEP-ID}}` | Full raw output from a completed step |
| `${{result.STEP-ID.summary}}` | Summary from `finish(summary:)` |
| `${{result.STEP-ID.status}}` | Status: `complete`, `error`, or `blocked` |
| `${{result.STEP-ID.artifacts}}` | The `<artifacts>` XML block from `finish` |
| `${{result.STEP-ID.files}}` | Human-readable file list (e.g., `src/auth.ts (created)`) |
| `${{fork.STEP-ID.answer}}` | User's answer from a fork step |
| `${{fork.STEP-ID.notes}}` | Optional notes the user added to a fork answer |
| `${{loop.STEP-ID.iteration}}` | Current iteration number (1-based) in a loop step |
| `${{loop.STEP-ID.max}}` | Maximum iterations configured for a loop step |

> **Resolution order:** Variables are expanded at dispatch time, not at parse time. `${{result.X}}` resolves to the result of step X if X has already completed — this is guaranteed when `X` is in the current step's `blockedBy` chain.

> **Missing values resolve to empty string.** A variable that references an unrun step, an undeclared input, or a non-existent field quietly becomes `""`.

> **Legacy `{variable}` syntax** (without `${{...}}`) is still accepted for backward compatibility but is deprecated. Use `${{...}}` in all new flows.

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
## developer
agent: developer
blockedBy: researcher
inputs:
  research_output: "${{result.researcher.summary}}"
  ticket_context: "${{result.ticket-fetch.artifacts}}"
```

### Reference in the system prompt

```markdown
You are a developer. Task: ${{task}}

Research context:
${{input.research_output}}

Ticket context:
${{input.ticket_context}}
```

If the `inputs:` list is not declared in the agent's frontmatter, the input values are still substituted but the system prompt has no `${{input.NAME}}` to expand them into — making them silently useless. Always declare inputs in the frontmatter.

---

## The `finish` Result Envelope

Agents must call `finish` as their last action to submit a structured result. The `finish` call's arguments are encoded as a `<result>` XML envelope in the output stream.

### Standard finish call

```
finish(
  summary="Implemented the feature. Added auth module with JWT support.",
  status="complete",
  files=[
    { path: "src/auth.ts",        action: "created" },
    { path: "tests/auth.test.ts", action: "created" }
  ],
  artifacts="<test_count>12</test_count><coverage>94%</coverage>"
)
```

This produces:

```xml
<result status="complete">
  <summary>Implemented the feature. Added auth module with JWT support.</summary>
  <files>
    <file path="src/auth.ts" action="created"/>
    <file path="tests/auth.test.ts" action="created"/>
  </files>
  <artifacts>
    <test_count>12</test_count>
    <coverage>94%</coverage>
  </artifacts>
</result>
```

### Decision/loop finish call

For `agent-decision` and `agent-loop-decision` steps, include the `branch` parameter:

```
finish(summary="Tests passing.", branch="finalize")
```

### Parameter reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `summary` | string | Human-readable summary. Shown in the dashboard and accessible via `${{result.STEP.summary}}`. |
| `status` | string | `"complete"` (default), `"error"`, or `"blocked"`. |
| `files` | list | Files the agent touched. Each entry: `{ path, action }` where action is `created`, `modified`, or `read`. |
| `artifacts` | string | Arbitrary XML data. Accessible via `${{result.STEP.artifacts}}` and `conditional` step checks. |
| `branch` | string | For decision steps only. Must match a key in the step's `branches:` map or one of `loop_target`/`exit_target`. |

### System prompt guidance for agents

Tell agents to call `finish` in their system prompt:

```markdown
When your work is complete, call `finish` with:
- A concise summary of what you did
- The list of files you created or modified
- Any structured data in the artifacts field that downstream steps might need
```

For decision agents:

```markdown
Analyze the situation, then call `finish` with:
- `summary`: Your reasoning
- `branch`: One of "needs-work" or "ready"
```
