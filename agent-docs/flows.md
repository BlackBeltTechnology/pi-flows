# Flow Reference

Complete reference for authoring flows in pi-flows. Covers all step types: syntax, field references, practical examples.

---

## Flow File Format

Flows: `.yaml` files with YAML frontmatter followed by step definitions. Each step has unique `id`, connects to other steps via `blockedBy` declarations to form DAG.

**Location:** `.pi/flows/flows/<name>.yaml` or package-registered flows directory.

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

> **Command name = file path, not `name:` field.** Slash command derived from file path:
>
> | File path | Command |
> |-----------|---------|
> | `.pi/flows/flows/research.yaml` | `/research` |
> | `.pi/flows/flows/my-domain/apply.yaml` | `/my-domain:apply` |

---

## Step Types

Steps form DAG based on `blockedBy` declarations. pi-flows schedules steps with no pending dependencies in parallel, respecting `max_concurrent`.

### Agent Step (default)

Dispatches named agent with task. Most common step type.

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

Pause execution, present options to user. Selected option determines which branch runs.

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
| `agent` | | Agent for autonomous decisions (Alt+A) and custom freetext routing. Required when `allowCustom` is set. |
| `task` | | Task description for the decision agent. Defaults to question + options. |

**Behavior:**

- **Single-select:** Routes to one branch. Unselected branches skipped (synthetic "skipped" results stored).
- **Multi-select:** Multiple branches run in parallel.
- **After selection:** User prompted for optional notes (Enter to skip). Fork context **automatically injected** into branch step's system prompt.

**Autonomous mode:** When Alt+A active, fork steps with `agent:` field skip user prompt, let agent decide automatically. Forks without `agent:` always prompt user.

---

### Conditional Step

Branch based on whether field from previous step's result is non-empty.

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

Delegate routing decision to agent. Agent analyzes context, calls `finish` with `branch` name.

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

If agent returns `branch` not in `branches`, flow errors.

---

### Agent Loop Decision Step

Iterative verify/fix cycles. Agent decides each iteration whether to loop back or exit.

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

**How agent decides:**

```
# Continue looping:
finish(summary="Tests still failing.", branch="developer")

# Exit the loop:
finish(summary="All tests passing.", branch="finalize")
```

`branch` value must exactly match `loop_target` or `exit_target`.

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

Delegate execution to another flow file. Sub-flow runs to completion before continuing.

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
- Sub-flow agent results flat-merged into parent's result context
- flow-ref step ID stores last agent's result
- Downstream steps can reference sub-flow agents: `${{result.sub-agent-id.summary}}`

---

### Code Step

Execute TypeScript handler function in-process. No agent or LLM dispatch.

**Syntax:**

```yaml
  - id: validate
    type: code
    inputs:
      data: "${{result.fetcher.artifacts}}"
    outputs:
      - name: is_valid
      - name: error_message
    on_complete: next-step
    on_error: error-handler
    timeout: 30000
```

**Field reference:**

| Field | Required | Description |
|-------|:--------:|-------------|
| `id` | ✓ | Unique step identifier. Filesystem-safe. Becomes handler filename. |
| `type` | ✓ | Must be `code`. |
| `inputs` | | Map of name → `${{...}}` template expression. Each value expanded to string at runtime. Unresolved → `""`. Never `undefined`. |
| `outputs` | | List of `{ name }` objects. Names unique, valid JS identifiers. Optional — omit for side-effect-only steps. |
| `target` | | Override handler file path. Steps with `target` get no generated scaffold. |
| `blockedBy` | | Array of step IDs that must complete before this step runs. |
| `on_complete` | | Step ID to route to on success. |
| `on_error` | | Step ID to route to on error. |
| `timeout` | | Milliseconds. Soft deadline — aborts `ctx.signal` on expiry → soft failure. |

**Handler locations:**

| File | Purpose |
|------|---------|
| `.pi/flows/handlers/<flow>/<id>.ts` | Real handler (implement here) |
| `.pi/flows/handlers/<flow>/<id>.ts.default` | Generated scaffold — `.default` suffix makes it un-importable (inert) |

Copy `.ts.default` → remove `.default` suffix → implement. Scaffold always regenerated on flow save or `/flows:generate <name>`. Real `.ts` never touched by generation. `target:` steps get no scaffold.

**Handler contract:**

```typescript
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

interface Input  { data: string }                                    // one key per declared input
interface Output { is_valid: string; error_message: string }         // one key per declared output

export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
  ctx.logger("validating...");
  ctx.setSummary("Validation complete");
  return { is_valid: "true", error_message: "" };
}
```

**`CodeNodeContext` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `signal` | `AbortSignal` | Aborted when `timeout` expires. Check cooperatively in loops. |
| `cwd` | `string` | Project root directory. |
| `logger(msg)` | `(msg: string) => void` | Stream text to step card. |
| `setSummary(text)` | `(text: string) => void` | Set step summary shown after completion. |
| `flowName` | `string` | Name of the running flow. |
| `stepId` | `string` | This step's `id`. |
| `task` | `string` | The flow task string. |

**Return rules:**

- Return exactly declared outputs. All keys present. No extras.
- No `outputs:` declared → return `{}`.
- `string` values: passthrough verbatim.
- `number` / `boolean` / `bigint` → coerced via `String()`.
- `object` / `array` / `null` → soft failure naming the offending key.

**Failure modes:**

| Cause | Outcome |
|-------|---------|
| Plain `throw` (any `Error`) | `soft` — routes `on_error`, else hard-fails flow |
| Contract violation (wrong/missing output keys) | `soft` |
| Coercion failure (`object`/`array`/`null` value) | `soft` |
| Missing handler file | `soft` |
| Timeout expired | `soft` |
| `throw new FlowHardError(msg)` | `hard` — stops flow regardless of `on_error` |

No retry layer. Execution in-process via jiti dynamic import. No subprocess.

**Drift detection:**

If real handler's `Input`/`Output` interfaces mismatch YAML `inputs`/`outputs` — non-fatal WARNING at generation time. Never blocks execution.

**Conditional check with code step outputs:**

`stepId.outputName` in `check:` resolves any declared typed output from merged result map. Falls back to `fullOutput` only when key absent. Standard fields (`summary`, `artifacts`, `files`, `status`) resolved as normal.

---

## Failure Modes

Node resolves to one outcome: `success` | `soft` | `hard`. Outcome decides routing.

| Outcome | Meaning | Routing |
|---------|---------|---------|
| `success` | Node completed work | Routes `on_complete` |
| `soft` | Recoverable failure. Node ran, reported logical problem | Routes `on_error` |
| `hard` | Unrecoverable failure | Aborts in-flight parallel steps, skips pending steps, ends flow status `error`, surfaces message |

```mermaid
flowchart TD
  N[Node runs] --> O{Outcome?}
  O -->|success| C[on_complete]
  O -->|soft| E{on_error declared?}
  E -->|yes| H[on_error]
  E -->|no| HF[Hard-fail flow]
  O -->|hard| HF
  HF --> A[Abort in-flight steps<br/>skip pending steps<br/>flow status = error]
```

### `on_error` = soft switch

`soft` routes `on_error` when node declares one. `soft` + no `on_error` → hard-fails flow. Fail-fast by default. Unhandled recoverable failure stops flow.

> **⚠️ BREAKING.** Previously: failure + no `on_error` → silent-continue. Now: hard-fails flow. Flows relying on silent-continue must add explicit `on_error`.

### Agent failure classification

Agent classified structurally. No error-message parsing. No deliberate fatal signal.

| Agent end state | Outcome |
|-----------------|---------|
| `finish(status:"complete")` | `success` |
| `finish(status:"error")` or `finish(status:"blocked")` | `soft` (ran, reported logical failure) |
| No `finish` + terminal API error (pi-coding-agent auto-retries exhausted: rate limit, quota, auth) | `hard` (provider unusable rest of flow) |
| No `finish` + no API error | `soft` |

No-finish reminder capped at 2. Reminders include `finish` tool-call format. Still no finish → clean `soft` failure. Never `status:"unknown"`. Never infinite loop.

### Transient retry delegated to pi

pi-coding-agent auto-retries transient errors (rate limit, 5xx, overloaded, network, timeout) with exponential backoff. pi-flows adds no redundant retry layer. Error reaching flow engine is terminal.

### Code / extension nodes

Thrown error decides outcome.

| Thrown | Outcome |
|--------|---------|
| Plain `throw` (any `Error`) | `soft` — routes `on_error` if declared, else hard-fails |
| `throw new FlowHardError(msg)` | Unconditional `hard` — stops flow regardless of `on_error` |

`FlowHardError` exported from package. See [public-api.md](./public-api.md) for shape and usage.

---

## Template Variable Reference

Template variables: placeholders in `task`, `inputs`, `question` fields. Expanded just before agent dispatched.

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

> **Resolution order:** Variables expand at dispatch time. `${{result.X}}` only valid if step `X` already completed (guaranteed when `X` is in `blockedBy`).

> **Missing value at runtime resolves to empty string.** Reference surviving validation but no value at dispatch expands to `""`. Reference correctness checked ahead of time — see below.

---

## Reference Validation

`validateFlowContent` checks every `${{result.X}}` and `${{result.X.field}}` at flow-load time. Invalid reference -> hard validation error. Blocks flow. No agent dispatched until fixed. Catches typos and broken wiring early. Does not silently expand to `""`.

Three rules:

**1. Step must exist.** Reference unknown step id -> hard validation error. Blocks flow.

**2. `.field` must resolve.** Agent and code steps: `.field` must be declared output (agent `outputs:` or code-step `outputs:`) OR standard field. Standard fields always resolve: `summary`, `status`, `artifacts`, `files`, `fullOutput`. `.field` neither declared output nor standard -> hard validation error.

**3. Referenced step must be ordered first.** `${{result.X}}` valid only if X guaranteed to complete before referencing step. Guarantee holds when X is transitive `blockedBy` ancestor OR X routes into referencing step via `on_complete` / `on_error` / branch / loop edge chain. Neither path -> hard validation error.

> **Engine does not auto-add dependency.** Ordering fails -> author adds `blockedBy: [X]` or routing edge. pi-flows reports missing ordering as error. Never silently wires it.

```mermaid
flowchart TD
  R["${{result.X.field}}" reference] --> E1{X exists?}
  E1 -->|no| ERR[Hard validation error]
  E1 -->|yes| E2{".field" declared output<br/>or standard field?}
  E2 -->|no| ERR
  E2 -->|yes| E3{X ordered before<br/>referencing step?}
  E3 -->|no| ERR
  E3 -->|yes| OK[Reference valid]
```

### `flow-ref` exception

Sub-flow step ids not statically known to parent. `flow-ref` step ordered before referencing step -> references to sub-flow ids NOT flagged as unknown. `flow-ref` is ordering guarantee. Field/existence checks skipped for those ids.

### Loop iteration 1-based

`${{loop.STEP.iteration}}` 1-based. Consistent across loop. First body pass observes `iteration == 1` (not `0`). Body pass N and loop-decision step both observe `${{loop.STEP.iteration}} == N`.

---

## Input Wiring

Inputs wire specific data from one step to another as named variables, separate from task text.

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

If `inputs:` not declared in agent's frontmatter, input values substituted but system prompt has no `${{input.NAME}}` to expand them into.

### File Content Injection (`file://` prefix)

When agent needs **content** of file (not just path), use `file://` prefix:

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
- Producing step **MUST** be in `blockedBy` so file exists at dispatch time
- File content injected **verbatim** (never template-expanded)
- If file doesn't exist, step fails with clear error

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
