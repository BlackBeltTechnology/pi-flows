# Flow Authoring Reference

This document is the complete format reference for agent `.md` files and flow `.yaml` files. It covers every frontmatter field, step type, and template variable available in pi-flows.

---

## Flow and Agent Authoring Workflow

To author a flow or agent in the main session, enable the authoring tools by setting `flows.editFlow: true` in `.pi/settings.json` (e.g. `{ "flows": { "editFlow": true } }`). At each session start pi-flows reads this setting and activates the two tools (`flow_agents` and `flow_write`); it also re-reads the setting at the start of each agent turn, so editing `.pi/settings.json` directly while a session is running flips the **tools** on the next agent turn without a restart (the re-check is change-gated). Note the asymmetry: only the tools reconcile live per turn — the `manage-flows` skill's prompt-visibility still applies on the next session start / reload, because turn/event hooks have no reload primitive. Once active, author with `flow_agents` and `flow_write`. Load `/skill:manage-flows` for the **`manage-flows`** skill — a native pi skill that guides agent and flow creation, available regardless of the setting.

**Recommended: toggle edit-mode live with `/flows:edit-mode <on|off>`.** This is preferred over hand-editing `settings.json` and restarting. The command performs four steps in one shot: (1) writes `flows.editFlow` to the **project** `.pi/settings.json` (read-merge-write, preserving other keys; never the global file); (2) syncs a project-local skill copy at `.pi/skills/manage-flows/SKILL.md`, materialized from pi-flows' packaged template, with frontmatter `disable-model-invocation` set to `!enabled`; (3) reconciles the `flow_agents`/`flow_write` tools to match; (4) triggers a live reload (`ctx.reload()`) so the change is active in the current session. With edit-mode **on**, the AI sees the `manage-flows` skill in its prompt and has the authoring tools; with it **off**, the skill is hidden from the prompt (still reachable via explicit `/skill:manage-flows`) and the tools are inactive. The project-local skill is also re-synced at every session start (idempotent), so the skill stays discoverable with frontmatter reflecting the current setting; the packaged copy under `node_modules` is never written. Dashboards can flip the same toggle by emitting the inbound `flow:set-edit-mode { enabled: boolean }` event (see [events-api.md](events-api.md)); on the event path tools update immediately but skill visibility applies on the next session start (no reload).

### Edit-flow tools

Both tools perform validation and write to discoverable locations (no raw `path` arguments):

- **`flow_agents`** — Agent catalog management.
  - `op: list` — Discover all available agents. Displays agent metadata from the frontmatter.
  - `op: write` — Validate agent `.md` frontmatter and body, then write to `.pi/flows/agents/<name>.md` (name extracted from frontmatter).

- **`flow_write`** — Flow file creation and editing.
  - Parameters: `namespace` (default: `custom`), `name`, `content`.
  - Validates the flow YAML, writes to `.pi/flows/flows/<namespace>/<name>/flow.yaml`.
  - Automatically registers as `/<namespace>:<name>` slash-command.
  - To edit an existing flow, read it, then call `flow_write` with the same `namespace` and `name` to overwrite.

> **Bundled flow layout.** Each flow is a **self-contained directory** at `.pi/flows/flows/<namespace>/<name>/`. The definition file is always `flow.yaml` inside it, and that flow's code-node handlers (`<id>.ts` and the generated `<id>.ts.default`) are **co-located in the same directory**. Handlers resolve relative to the flow's own directory — `dirname(flow.source)/<id>.ts` — in both the executor and the generator, so generated and runtime paths are always identical. Deleting a flow removes the whole directory, so handlers can never be orphaned. **BREAKING:** the previous flat layout (`.pi/flows/flows/<namespace>/<name>.yaml`) and the parallel `.pi/flows/handlers/<flow>/` tree are no longer read — there is no fallback. To migrate, move `<name>.yaml` → `<name>/flow.yaml`, move that flow's handlers into the same directory.

### Model field guidance

The `model:` field in agent frontmatter accepts three forms:

1. **Role alias (preferred):** `@coding`, `@planning`, `@fast`, `@architect`. Resolved via active role-to-model mapping set with `/roles`.
2. **Model ID with thinking:** `claude-sonnet-4-20250514:high`. Explicit model; `:high` sets thinking level unless overridden by `thinking:` field.
3. **Bare model ID:** `claude-haiku-3-5-20241022`. Used as-is; thinking comes from `thinking:` field or none.

The `manage-flows` skill documents these forms in detail for interactive guidance.

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
fork_session: false
context_files:
  - AGENTS.md
  - docs/conventions.md
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
| `name` | `string` | Unique agent identifier. Referenced in flow steps (`agent: my-agent`) and in the `flow_agents` catalog (op `list`). Must be unique across all registered agents. |
| `description` | `string` | Human-readable description. Shown in listings and used by the Architect to understand the agent's purpose. |
| `model` | `string` | Model reference. See **Model references** below. |
| `tools` | `string` | Comma-separated list of tools the agent may use. The guard blocks any tool not in this list. |

#### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `thinking` | `string` | — | Extended thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Overrides any thinking suffix in `model`. |
| `skills` | `string` | — | Comma-separated skill names. Each skill's `SKILL.md` is injected into the system prompt. Topic files are accessed via `skill_read`. |
| `inputs` | `string[]` | — | Declared input names. These become available as `${{input.NAME}}` in the system prompt. The flow step must wire them via `inputs:`. |
| `outputs` | `string[]` or object array | — | Declared output names. These are added as parameters on the `finish` tool and accessible as `${{result.STEP.outputName}}` in downstream steps. Declared outputs are **required by default** — see **Outputs** below. Expanded entries accept optional `type` and `pattern` for validation. |
| `interactive` | `boolean` | `false` | If `true`, the agent session allows interactive UI prompts mid-task. |
| `output` | `string` | — | Default output file path (hint for display; not enforced). |
| `fork_session` | `boolean` | `false` | If `true`, the spawned agent inherits the operator's main-session conversation data via the SDK `SessionManager.forkFrom` (forks the operator's persisted session file). Falls back to a fresh in-memory session when the main session is not persisted. Agent writes land in the fork, not the operator's live session. |
| `context_files` | `string[]` | — | List of file paths, each resolved relative to project cwd. Read at spawn and injected into the system prompt as a `## Context: <path>` preamble section. Missing/unreadable files are skipped (non-fatal). `AGENTS.md` is just one possible path. |
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
- To pass a file's **contents**, pass its **path** as an input (typically a `*_path` output) and have the agent read it at runtime via its `read` tool (subject to `access.read`). The engine no longer injects file content (see [Passing file-backed data](#passing-file-backed-data)).

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

Expanded entries also accept optional `type` and `pattern` for validation:
```markdown
---
outputs:
  - name: file_path
    description: Absolute path to generated file
    pattern: "^/.+"
  - name: count
    type: number
---
```

- `type` — one of `string`, `number`, `boolean`, `object`, or `array`. The output is **stored in its real JSON type** under the result's `outputs`, never coerced to a string. When the declared `type` is non-string, the `finish` schema accepts that type and validates the emitted value against it before storing it.
- `pattern` — a regex the value (as text) must match. Explicit `pattern` wins over `type`. An invalid regex degrades to an unconstrained required string.

**Required by default:** declared outputs are required. Missing or `type`/`pattern`-violating outputs cause the `finish` call to be rejected and the agent re-prompted via the existing finish retry loop; the step fails after `MAX_FINISH_RETRIES`. Enforced at the finish-tool schema level.

Declared outputs become parameters on the `finish` tool. The agent sets them when calling `finish`:
```
finish({
  status: "complete",
  summary: "Analysis complete",
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

The `architect:` metadata block guides agent discovery via the `flow_agents` list operation, helping you compose flows from available agents.

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
inputs:                          # optional — typed input schema (see below)
  ref:   { type: string, required: true }
  count: { type: number }

steps:
  - ...
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Unique flow identifier. Becomes the slash-command. The command id is derived from the directory structure `<namespace>/<name>/flow.yaml`: `flows/judo/build/flow.yaml` → `judo:build`. |
| `description` | Yes | — | Human-readable description. Shown in `/help` and flow listings. |
| `steps` | Yes | — | Ordered list of flow steps. |
| `max_concurrent` | No | `4` | Maximum number of agent steps running in parallel within a DAG segment. |
| `task_required` | No | `false` | When `true`, prompts the user for a task description if the slash-command is invoked with no arguments. The answer becomes `${{task}}`. |
| `task_prompt` | No | `"Describe what you want <name> to do:"` | Custom prompt text shown when `task_required` triggers. |
| `inputs` | No | — | Optional typed input schema (see [Typed flow inputs](#typed-flow-inputs)). |

---

### Typed flow inputs

A flow may declare an optional `inputs:` schema — a mapping of input name to `{ type, required? }`:

```yaml
inputs:
  ref:   { type: string, required: true }
  count: { type: number }
  config: { type: object }
```

| Field | Description |
|-------|-------------|
| `type` | One of `string`, `number`, `boolean`, `object`, `array`. Required; an omitted or unknown type is a validation error. |
| `required` | When `true`, the run fails to start if the input is absent. Default `false`. |

**Starting a run with structured inputs.** Alongside the existing `task` string, a run may be started with a structured `inputs` object across every invocation path (slash command, the `flow:run` event's `inputs` field, and the programmatic run API). Provided inputs are validated against the schema; a missing `required` input or a type mismatch fails the run start with a diagnostic. A flow with no `inputs:` schema is still startable with only `task`, and `${{task}}` resolves as before — the structured object is additive.

**Referencing inputs.** Declared inputs are referenceable as `${{flow.input.<name>}}`. They follow the same typed-delivery rules as result outputs: a code-node input wired to exactly `${{flow.input.count}}` receives the typed value (e.g. the number `3`), while a flow input interpolated into agent text or an embedded expression is JIT-serialized to compact JSON.

---

### Typed data between steps

Declared `outputs` cross step boundaries in their **real JSON types** — they are never coerced to strings in storage. Serialization happens just-in-time, only at a text boundary:

- **Whole-value code-node input** — when a code node's input value is *exactly* one reference (`${{result.X.name}}` or `${{flow.input.name}}`, no surrounding text), the handler receives the value **unchanged** (object/array/number/boolean/string).
- **Embedded reference** — when a reference sits inside other text, or is interpolated into an agent system prompt/task, the non-string value is serialized to **compact JSON** at that point. Scalar strings pass through unchanged.

`code → code` whole-value handoff therefore involves zero stringify/parse round-trips. For large or file-backed data, pass a path and read it just-in-time (see [Passing file-backed data](#passing-file-backed-data)) rather than inlining it.

---

### Execution model

The engine splits the flat step list into **segments**:

```
steps: [A, B, C, fork, D, E, agent-decision, F]
        ──────────  ────  ──────  ─────────────  ──
         DAG seg    sep   DAG seg    sep          DAG seg
         parallel         parallel
         (A||B||C)        (D||E)                  (F)
```

- **DAG segments** — consecutive `agent` steps. Executed as a parallel wave, respecting `blockedBy` dependencies. All steps in a wave that have no unsatisfied `blockedBy` entries fire concurrently, up to `max_concurrent`.
- **Separator steps** — `fork`, `agent-decision`, `code-decision`. Execute one at a time and control routing.
- **Cross-segment routing** — `on_error` on agent steps can jump to any step ID, including steps in different segments. On success a step falls through to the next step in file order; forward path selection (including skipping steps) is expressed with a `fork` or `code-decision` node.

---

### Step types

Every step requires BOTH a unique `id` field AND an explicit `type` field. The parser does **not** infer type from which fields are present — a step missing `type:` is rejected with an error listing the valid types.

The canonical step types are `agent`, `agent-decision`, `code`, `code-decision`, and `fork`. The table below is a reference for the fields that distinguish each type; it is **not** an inference rule — you must still declare `type:` on every step.

| Step type | Distinguishing fields |
|-----------|----------------------|
| `fork` | `question` |
| `agent-decision` | `branches` (no `question`) |
| `agent` | `agent` |
| `code` | (handler-only — no distinguishing field) |
| `code-decision` | `branches` + handler |

> **Removed types.** `conditional` and `agent-loop-decision` no longer exist. The parser rejects them with migration errors. Replace `conditional` with the code decision step and `agent-loop-decision` with an `agent-decision` loop (see Loops).

---

#### 1. Agent step

The primary step type. Dispatches a named agent with an optional task and inputs.

```yaml
- id: researcher
  type: agent           # required
  agent: my-researcher
  task: >
    Research the codebase for: ${{task}}
    Focus on modules related to authentication.
  blockedBy: [project-context]
  inputs:
    project_context: ${{result.project-context.summary}}
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
| `on_error` | No | Step ID to route to on error. |
| `output` | No | Output file path hint. |

> On success a step **falls through** to the next step in file order — there is no success-routing field. Order a later step after this one with `blockedBy`; select a forward path (including skipping steps) with a `fork` or `code-decision` node.

> **⚠️ Breaking change — `on_complete` removed.** `on_complete` no longer exists on `agent` or `code` steps; declaring it is a **validation error**. Migrate: `on_complete: X` where `X` is simply the next step → **delete the line**; `on_complete: X` that skips past intervening steps → use a `code-decision`/`fork` node to select the forward path; a `${{result.X}}` reference that relied on an `on_complete` chain for ordering → add `blockedBy: [X]`.

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

#### 3. Code decision step

Run a TypeScript handler exactly like a [code step](#7-code-step), then route on a reserved `branch` output. Use it for deterministic routing — thresholds, presence checks, computed classification — without spawning an agent.

```yaml
- id: route-approval
  type: code-decision
  inputs:
    score: ${{result.reconcile.score}}
  outputs:
    - name: approvers      # optional data outputs (never `branch`)
  branches:
    auto_approve: export
    needs_human: human-review
    park: hold
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. Determines the handler filename — must be filesystem-safe. |
| `type` | Yes | Must be `code-decision`. Not inferred; always explicit. |
| `branches` | Yes | Map of branch label → target step ID. Must declare **at least 2** branches. |
| `inputs` | No | Same as a code step — map of input name → `${{...}}` template string. |
| `outputs` | No | Optional data outputs the handler must return. **Never include `branch`** — it is reserved. |
| `target` | No | Override the handler file path. Skips scaffold generation. |
| `blockedBy` | No | Step IDs that must complete before this step runs. |
| `max_iterations` | No | Required only when a branch target points to an earlier step (a loop). See [Loops](#5-loops). |
| `timeout` | No | Soft deadline in milliseconds. |

**Handler contract.** Identical to a [code step](#7-code-step) — same handler path (`<flow-dir>/<id>.ts` co-located beside `flow.yaml`, or explicit `target:`), same `inputs`/`outputs`, same soft/hard failure model and value coercion. The handler ADDITIONALLY returns a reserved `branch: string` key:

```typescript
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

interface Input  { score: string }
type Branch = "auto_approve" | "needs_human" | "park";
interface Output { approvers: string }

export default async function (
  input: Input,
  ctx: CodeNodeContext,
): Promise<{ branch: Branch } & Output> {
  const score = Number(input.score);
  if (score >= 0.9) return { branch: "auto_approve", approvers: "alice,bob" };
  if (score >= 0.5) return { branch: "needs_human", approvers: "" };
  return { branch: "park", approvers: "" };
}
```

- `branch` resolves against the step's `branches:` map; the flow routes to the mapped step.
- `branch` is **reserved** — declaring an output named `branch` in `outputs:` is a validation error.
- Data outputs (e.g. `approvers`) follow the normal code-step return contract.

| Condition | Outcome |
|-----------|---------|
| Fewer than 2 `branches` | Validation error — use a plain `code` step. |
| `branch` declared in `outputs:` | Validation error — `branch` is reserved. |
| Handler return omits `branch` | Soft failure naming the reserved `branch` output. |
| Returned `branch` not in `branches:` | **Hard** failure — halts the flow (consistent with `agent-decision`). |

**Type-safe scaffold.** `/flows:generate` emits a `type Branch = "auto_approve" | "needs_human" | "park";` union per `code-decision` and types the return as `Promise<{ branch: Branch } & Output>`, so an off-map label is a compile-time error. Scaffolds write a `.ts.default` and never overwrite an implemented handler.

> **Migrating from `conditional`.** Replace `type: conditional` with `type: code-decision`. Read the value previously in `check: <stepId>.<key>` as a handler **input** and return `{ branch: "present" }` or `{ branch: "absent" }`, with `branches: { present: <present-target>, absent: <absent-target> }`. Standard fields (`summary`, `status`, `fullOutput`) remain available as `${{result.<stepId>.<field>}}` inputs.

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
| `max_iterations` | No | Required only when a branch target points to an earlier step (a loop). See [Loops](#5-loops). |

The guard injects the branch names into the `finish` tool parameters as a union type. The agent must pick one of the declared branch names. A `branch` not in `branches:` hard-fails the flow. An `agent-decision` may loop by pointing a branch at an earlier step — see [Loops](#5-loops).

---

#### 5. Loops

A **loop** is any `*-decision` node — `agent-decision` or `code-decision` — whose branch target points to an **earlier** step, re-entering the graph to form a cycle. There is no dedicated loop step type; a loop is just a backward branch edge.

- A `*-decision` node with a branch target pointing to an earlier step **MUST** declare `max_iterations`.
- The engine tracks per-node iteration counts and forces exit when the cap is reached — control falls through to the next step.
- A `*-decision` node whose branches all point forward needs no `max_iterations`.
- The dashboard ↻ iteration badge is driven by the `flow:loop-iteration` event, emitted only when a backward edge is actually taken — not inferred from the presence of `max_iterations`.

**Typical verify/fix loop (agent-driven):**
```yaml
- id: implement
  agent: implementer
  task: Implement the feature.

- id: verify
  agent: verifier
  blockedBy: [implement]
  task: Run tests and verify the implementation.

- id: should-fix
  type: agent-decision
  agent: flow-decision
  task: >
    Iteration ${{loop.should-fix.iteration}}/${{loop.should-fix.max}}.
    Verification: ${{result.verify.summary}}
    Choose "fixer" if failures remain, "done" if all pass.
  branches:
    fixer: fixer    # backward edge → loop
    done: done      # forward edge → exit
  max_iterations: 3

- id: fixer
  agent: implementer
  task: Fix the failing tests identified by the verifier.
  inputs:
    test_output: ${{result.verify.summary}}
  # the loop's backward edge is driven by the `should-fix` decision branch,
  # not by success routing — success falls through to the next step in file order

- id: done
  agent: summarizer
  task: Summarize the completed implementation.
```

The agent calls `finish({ branch: "fixer" })` to loop or `finish({ branch: "done" })` to exit. A `code-decision` loops the same way — return `{ branch: "fixer" }` from the handler.

**Routing node semantics.** A routing node (`fork`, `agent-decision`, `code-decision`) always executes, so its own outputs are always populated. For a loop, a node's outputs reflect the **last** iteration. Forward branches not taken receive synthetic `skipped` results; an unresolved `${{result.<id>.<field>}}` expands to the empty string — never `undefined`.

> **Migrating from `agent-loop-decision`.** Replace `type: agent-loop-decision` with `type: agent-decision`. Move `loop_target` and `exit_target` into `branches:` (e.g. `branches: { rework: <loop_target>, done: <exit_target> }`) and keep `max_iterations`. The agent calls `finish({ branch: "rework" })` or `finish({ branch: "done" })`.

---

#### 6. Code step

Run a TypeScript handler function in-process. Use for deterministic logic that does not need an agent — validation, data transformation, computation.

```yaml
- id: validate-nav
  type: code             # required — not inferred
  inputs:
    invoice: "${{result.extract.canonical}}"
  outputs:
    - name: valid
    - name: nav_record
  blockedBy: [extract]
  on_error: park
  timeout: 5000          # optional soft deadline in ms
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. Determines the handler filename — must be filesystem-safe. |
| `type` | Yes | Must be `"code"`. Always set explicitly; this type is not inferred. |
| `inputs` | No | Map of input name → `${{...}}` template string. When a value is **exactly one** reference (`${{result.X.name}}` or `${{flow.input.name}}`, no surrounding text) the handler receives that value **unchanged** in its real JSON type; when the reference is embedded in other text the handler receives the interpolated (JIT-serialized) string. Unresolved templates become `""`. Input names must be valid JS identifiers. |
| `outputs` | No | List of `{ name }` objects. Each name must be a valid JS identifier, unique within the step. The handler return object must contain exactly these keys. |
| `target` | No | Override the handler file path. Skips scaffold generation; the author owns the file. |
| `blockedBy` | No | Step IDs that must complete before this step runs. |
| `on_error` | No | Step ID to route to on soft failure. |
| `timeout` | No | Soft deadline in milliseconds. When exceeded the engine aborts `ctx.signal` and the step soft-fails. |

**Handler contract**

The handler is the module’s **default export**, an `async` function `(input, ctx) => output`:

```typescript
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

interface Input  { invoice: Record<string, unknown> }
interface Output { valid: boolean; nav_record: Record<string, unknown> }

export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
  ctx.logger("validating invoice...");
  ctx.setSummary("Invoice validated");
  return { valid: true, nav_record: { id: 1 } };
}
```

`CodeNodeContext` fields:

| Field | Type | Description |
|-------|------|-------------|
| `signal` | `AbortSignal` | Cooperative cancellation. Check or pass to async I/O. |
| `cwd` | `string` | Project root directory. |
| `logger` | `(msg: string) => void` | Streams a message to the step card in real time. |
| `setSummary` | `(text: string) => void` | Sets the step’s summary (used as `${{result.id.summary}}` downstream). |
| `flowName` | `string` | Name of the running flow. |
| `stepId` | `string` | The step’s `id`. |
| `task` | `string` | The task string passed when the flow was invoked. |

**Return contract:** the returned object must contain **exactly** the declared `outputs` — every declared key present, no undeclared extras. A step with no `outputs` must return `{}`. A missing or extra key is a soft failure naming the offending key.

**Structured returns:** a handler may return **any JSON-compatible value** (`string`, `number`, `boolean`, `object`, `array`, `null`) for each declared output. Each value is stored in its real type under the result's `outputs` — there is no string coercion, and an `object`/`array`/`null` return is **no longer** a soft failure.

**Failure modes:**

| Thrown | Outcome |
|--------|---------|
| Plain `Error` (or contract / coercion violation, missing handler, timeout) | Soft failure — routes to `on_error`; hard-fails the flow when `on_error` is unset |
| `new FlowHardError(msg)` | Unconditional hard failure — stops the flow immediately |

**Handler location and generation**

The real handler is co-located with the flow definition: `<flow-dir>/<id>.ts`, where `<flow-dir>` is `dirname(flow.source)` — the same directory that holds `flow.yaml`. Alongside it the engine writes a scaffold template `<flow-dir>/<id>.ts.default` on every successful `flow_write` and via `/flows:generate <name>`. The generator and the executor resolve this path identically (source-relative), so generated and runtime paths never diverge. The `.default` extension makes it un-importable; the template is always regenerated from the YAML — it never touches the real `.ts`.

Template content:
- `import type { CodeNodeContext }` from the package
- `interface Input` derived from the step’s `inputs`
- `interface Output` derived from the step’s `outputs`
- A default-export stub with a `// TODO` body returning placeholder output values

Workflow: copy the `.ts.default`, drop `.default`, implement the body.

When a `target:` field is present, no template is generated; the author owns that file.

After a successful write, the engine emits a non-fatal drift **warning** if the real handler’s `interface Input` / `interface Output` blocks disagree with the YAML — silently skipped when those blocks are absent (runtime shape validation is the backstop).

**Presence routing with a `code-decision`**

A `code-decision` handler can read any typed output from an upstream code step as an input and route on its presence:

```yaml
- id: route-on-valid
  type: code-decision
  inputs:
    valid: ${{result.validate-nav.valid}}    # typed output from the code step
  branches:
    present: approve
    absent: park
```

```typescript
type Branch = "present" | "absent";
export default async function (input: { valid: string }): Promise<{ branch: Branch }> {
  return { branch: input.valid ? "present" : "absent" };
}
```

Typed outputs resolve against the merged typed-output map first, falling back to `fullOutput` only when the key is absent.

---

### Template variables

Template expressions `${{...}}` are expanded in `task`, `inputs` values, and `question`. They are **not** validated at parse time — a typo silently resolves to an empty string.

| Variable | Resolves to |
|----------|------------|
| `${{task}}` | The original user task string (from command args or `task_required` prompt). |
| `${{input.NAME}}` | Named input passed to this step via the `inputs:` block. |
| `${{result.STEP_ID.status}}` | Step result status: `"complete"`, `"error"`, `"blocked"`, `"unknown"`. |
| `${{result.STEP_ID.summary}}` | Summary string from the step's `finish` call. |
| `${{result.STEP_ID.fullOutput}}` | Full raw output text. Use sparingly — can be very large. |
| `${{result.STEP_ID.OUTPUTNAME}}` | A declared typed output (from an agent's or code step's `outputs:`), held under the result's `outputs`. A produced file path is conveyed this way as a `*_path` output. |
| `${{flow.input.NAME}}` | A declared flow input (see [Typed flow inputs](#typed-flow-inputs)). |
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
    project_root: ${{result.researcher.project_root}}
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

### Passing file-backed data

The engine does **not** read a file and inject its content into a prompt — the `file://` input prefix is no longer a special form. Instead, pass the file's **path** as a value (typically a declared `*_path` output) and let the consumer read it just-in-time: an agent reads it via its `read` tool (subject to `access.read`), and a code node reads it from the filesystem.

```yaml
- id: validator
  agent: validator         # must declare the `read` tool
  blockedBy: [generator]
  inputs:
    spec_path: specs/api-spec.md
    report_path: ${{result.generator.report_path}}
```

The agent's prompt then instructs it to read those paths:

```markdown
Read the spec at ${{input.spec_path}} and the generated report at ${{input.report_path}}.
```

Rules:
- The producing step must be in `blockedBy` so the file exists by the time the consumer reads it.
- The consuming agent must hold the `read` tool and a matching `access.read` glob. Flow validation emits a **warning** when a `*_path`/`*_file` input is wired into an agent that lacks the `read` tool.
- For small, always-needed files, `context_files` (read at spawn) remains available.

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
| Built-in flows | `pi-flows/flows/` | `<namespace>/<name>/flow.yaml` |
| Project-local flows | `.pi/flows/flows/` | `<namespace>/<name>/flow.yaml` |
| Package flows | Registered via `flow:register-flows-dir` | `<namespace>/<name>/flow.yaml` |
| Skills | Registered via `flow:register-skills-dir` | `<name>/SKILL.md` |

**Override priority (highest to lowest):**
1. Project-local (`.pi/flows/`)
2. Package (registered via events)
3. pi-flows built-ins
