# Flow Reference

This document covers the flow step types available for authoring custom flows in pi-flows.

## Flow File Format

Flows are `.yaml` files with top-level metadata and a `steps:` array. Each step has an `id` field and either an explicit `type` field or an inferred type based on its fields.

## Step Types

### Agent Step (default)

Spawns an AI agent as an isolated child process.

```yaml
- id: my-step
  agent: agent-name           # Agent to run
  task: >                     # Task description (supports interpolation)
    Do something specific.
    Context: ${{result.prior-step.summary}}
  blockedBy: [step-a, step-b] # Wait for these steps to complete
  inputs:                     # Named inputs passed to agent
    data: "${{result.step-a.artifacts}}"
```

**Lifecycle:**
1. Wait until all `blockedBy` steps complete
2. Resolve interpolation (`${{result.*}}` and `${{task}}`)
3. Spawn agent process with resolved task and inputs
4. Agent executes, produces `<result>` output
5. Result stored in `ctx.results[step-id]`

---

### Fork Step

Presents options to the user and routes to one or more branches.

```yaml
- id: choose
  type: fork
  question: "Which approach?"        # Displayed to user
  options: [Option A, Option B]       # Available choices
  multiSelect: false                  # true → multiple branches run
  branches:
    Option A: step-for-a              # Map option → target step
    Option B: step-for-b
```

**Single-select behavior:** Routes to one branch; steps reachable only from non-selected branches are skipped (synthetic "skipped" results stored for dependency satisfaction).

**Multi-select behavior:** Multiple branches run in parallel. Unselected branches are skipped.

After the user picks an option, they are always prompted for optional notes (Enter to skip). Fork context (question, selected option, notes, and who decided) is **automatically injected** into the branch step's system prompt.

---

### Conditional Step

Automatically routes based on whether a prior step's result field is non-empty.

```yaml
- id: check
  type: conditional
  check: step-id.field              # Format: <step-id>.<field-name>
  present: target-when-present      # Route if field is non-empty
  absent: target-when-absent        # Route if field is empty/missing
```

**Resolution logic:**
1. Parse `check` — extract step ID (everything before last `.`) and field name (last segment)
2. Look up `ctx.results[stepId]`
3. If result exists and `result[field].trim().length > 0` → route to `present`
4. Otherwise → route to `absent`

Common patterns:
- `check: step.artifacts` — check if step produced structured artifacts
- `check: step.summary` — check if step produced a summary (always true for completed steps)

---

### Agent Loop Decision

A decision agent evaluates results and chooses to loop or exit.

```yaml
- id: verify-loop
  type: agent-loop-decision
  agent: flow-decision              # Built-in decision agent
  task: >
    Evaluate: ${{result.verifier.summary}}
    If issues remain, choose "loop". If all good, choose "exit".
  loop_target: fix-step             # Jump back on "loop"
  exit_target: done-step            # Proceed on "exit"
  max_iterations: 3                 # Safety limit (prevents infinite loops)
```

**Execution:**
1. Spawn the decision agent with the task
2. Agent outputs either "loop" or "exit"
3. Loop → re-execute from `loop_target`
4. Exit → proceed to `exit_target`
5. If `max_iterations` reached → force exit

---

### Flow Reference

Executes a sub-flow and propagates results back to the parent.

```yaml
- id: sub-execution
  type: flow-ref
  path: .pi/flows/flows/sub-flow.yaml   # Path to sub-flow (supports globs)
  on_complete: next-step                 # Resume here after sub-flow
```

**Result propagation:**
- Sub-flow agent results are flat-merged into the parent's result context
- The flow-ref step ID itself stores the last agent's result
- Downstream steps can reference sub-flow agents: `${{result.sub-agent-id.summary}}`

---

## Result Interpolation

### Syntax

```
${{result.<step-id>.<field>}}
```

Available fields:
- `summary` — text summary from the agent
- `artifacts` — structured XML artifact data
- `files` — list of files created/modified

### Usage in task text

```yaml
task: >
  Use the findings from research:
  ${{result.research-step.summary}}
  
  Check these artifacts:
  ${{result.research-step.artifacts}}
```

### Usage in inputs

```yaml
inputs:
  prior_work: "${{result.research-step.summary}}"
  model_data: "${{result.model-step.artifacts}}"
```

### Common mistake

```yaml
# ✗ WRONG — angle brackets
inputs:
  data: "<step.summary>"

# ✓ CORRECT — double curly braces  
inputs:
  data: "${{result.step.summary}}"
```

Flow validation catches angle-bracket syntax and suggests the correct format.

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

### Parallel Research with Fan-In

```yaml
name: multi-domain-research
description: Research multiple domains in parallel
steps:
  - id: backend-research
    agent: backend-researcher
    task: Investigate backend patterns for ${{task}}

  - id: frontend-research
    agent: frontend-researcher
    task: Investigate frontend patterns for ${{task}}

  - id: summarizer
    agent: summarizer
    blockedBy: [backend-research, frontend-research]
    inputs:
      backend: "${{result.backend-research.summary}}"
      frontend: "${{result.frontend-research.summary}}"
    task: Synthesize research findings
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
    task: Build and verify the implementation

  - id: fix
    agent: developer
    blockedBy: [verify]
    inputs:
      issues: "${{result.verify.artifacts}}"
    task: Fix the issues found during verification

  - id: verify-loop
    type: agent-loop-decision
    agent: flow-decision
    task: "Evaluate: ${{result.verify.summary}}"
    loop_target: fix
    exit_target: done
    max_iterations: 3

  - id: done
    agent: summarizer
    task: Summarize the completed work
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

