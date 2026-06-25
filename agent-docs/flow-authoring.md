# Flow Authoring Reference

Complete format reference for agent `.md` files and flow `.yaml` files. Covers every frontmatter field, step type, template variable in pi-flows.

---

## Flow and Agent Authoring Workflow

Set `flows.editFlow: true` in `.pi/settings.json` (e.g. `{ "flows": { "editFlow": true } }`). Session start reads setting, activates `flow_agents` and `flow_write` tools. Change takes effect next session start. Once active, author with `flow_agents`/`flow_write`. Load `/skill:edit-flow` for reference skill (available regardless of setting).

Recommended: `/flows:edit-mode <on|off>` toggles edit-mode live. Preferred over hand-editing settings.json + restart.
`/flows:edit-mode on` -> write flows.editFlow=true to project `.pi/settings.json`, skill `disable-model-invocation`=false, activate `flow_agents`/`flow_write`, reload.
`/flows:edit-mode off` -> write flows.editFlow=false, skill `disable-model-invocation`=true, deactivate `flow_agents`/`flow_write`, reload.
Writes project `.pi/settings.json` read-merge-write. Preserves other keys. Never global file.
Syncs project-local skill `.pi/skills/edit-flow/SKILL.md` from packaged template. Sets frontmatter `disable-model-invocation` = `!enabled`. Packaged copy under `node_modules` never written.
Command path calls `ctx.reload()`. Change live in current session.
Edit-mode on -> AI sees `edit-flow` skill + has authoring tools. Off -> skill hidden from prompt (reach via `/skill:edit-flow`), tools inactive.
Project-local skill re-synced every session_start (idempotent). Skill discoverable by default, frontmatter reflects current setting.
Dashboards emit inbound event `flow:set-edit-mode { enabled: boolean }`. Event path: tools update immediately, skill visibility next session start (no reload). See events-api.md.

Tools validate and write to discoverable locations (no raw `path`):

**`flow_agents`** — agent catalog.
- `op: list` → discover all agents, show metadata from frontmatter.
- `op: write` → validate agent `.md` frontmatter and body, write to `.pi/flows/agents/<name>.md` (name from frontmatter).

**`flow_write`** — flow file creation and editing.
- Parameters: `namespace` (default: `custom`), `name`, `content`.
- Validates flow YAML. Writes `.pi/flows/flows/<namespace>/<name>.yaml`.
- Registers as `/<namespace>:<name>` slash-command.
- Edit = read existing file, call `flow_write` with same namespace + name.

**Model field** accepts three forms:
1. Role alias (preferred): `@coding`, `@planning`, `@fast`, `@architect`. Resolved via `/roles`.
2. Model ID + thinking: `claude-sonnet-4-20250514:high`. `:high` overrides `thinking:` field.
3. Bare model ID: `claude-haiku-3-5-20241022`. Thinking from `thinking:` field or none.

`edit-flow` skill documents forms interactively.

---

## Agent Files (`.md`)

Agent files: Markdown documents with YAML frontmatter. Frontmatter configures agent. Markdown body: system prompt.

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
| `outputs` | `string[]` or object array | — | Declared output names. Become parameters on `finish` tool. Access as `${{result.STEP.outputName}}` downstream. Required by default — see **Outputs**. Expanded entries accept optional `type`, `pattern`. |
| `interactive` | `boolean` | `false` | If `true`, the agent session allows interactive UI prompts mid-task. |
| `output` | `string` | — | Default output file path (hint for display; not enforced). |
| `fork_session` | `boolean` | `false` | `true` forks operator main-session via SDK `SessionManager.forkFrom`. Inherits operator persisted session file. Falls back to fresh in-memory session when main session not persisted. Agent writes land in fork, not operator live session. |
| `context_files` | `string[]` | — | File paths, each resolved relative to project cwd. Read at spawn. Injected into system prompt as `## Context: <path>` preamble section. Missing/unreadable files skipped, non-fatal. `AGENTS.md` one possible path. |
| `access` | block | — | Access control rules. See **Access control** below. |
| `card` | block | — | Dashboard card configuration. See **Card configuration** below. |
| `architect` | block | — | Metadata used by the Architect when deciding which agents to use. See **Architect metadata** below. |

---

### Model references

`model` field accepts three formats:

| Format | Example | Description |
|--------|---------|-------------|
| Role alias | `@planning` | Resolved via the active role-to-model mapping (set with `/roles` command). |
| Model ID with thinking | `claude-sonnet-4-20250514:high` | Explicit model ID; `:high` sets thinking level unless `thinking:` field overrides it. |
| Plain model ID | `claude-haiku-3-5-20241022` | Used as-is; thinking from `thinking:` field or none. |

**Built-in roles:** `@planning`, `@coding`, `@fast`, `@architect`. Custom roles added via `/roles` command.

---

### Tools reference

`tools:` field: comma-separated list. Standard tools:

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

Extension-registered tools (via `flow:register-tool`) also listed here by name.

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

- Each input name must wire in flow step's `inputs:` block.
- Unset inputs expand to empty string.
- Use `file://` prefix in flow's `inputs:` value to inject file content (see [File content injection](#file-content-injection)).

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

Expanded entries accept optional `type`, `pattern` for validation:
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

- `type` — `string`, `number`, or `boolean`. Outputs stay string-valued downstream. `type` constrains string content. `number` → numeric string. `boolean` → `true`|`false`.
- `pattern` — regex string must match. Explicit `pattern` wins over `type`. Invalid regex degrades to unconstrained required string.

**Required by default:** declared outputs required. Missing or `type`/`pattern`-violating outputs reject `finish` call. Agent re-prompted via existing finish retry loop. Step fails after `MAX_FINISH_RETRIES`. Enforced at finish-tool schema level.

Declared outputs become parameters on `finish` tool. Agent sets them when calling `finish`:
```
finish({
  status: "complete",
  summary: "Analysis complete",
  files: [],
  findings: "Found 3 critical issues...",
  verdict: "fail"
})
```

Downstream steps access as: `${{result.STEP_ID.findings}}`, `${{result.STEP_ID.verdict}}`.

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

`architect:` metadata guides agent discovery via `flow_agents` list. Helps compose flows from available agents.

---

## Flow Files (`.yaml`)

Flows: YAML files defining ordered list of steps. Engine splits steps into DAG segments (parallel agent groups) separated by control-flow steps.

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

Engine splits flat step list into **segments**:

```
steps: [A, B, C, fork, D, E, agent-decision, F]
        ──────────  ────  ──────  ─────────────  ──
         DAG seg    sep   DAG seg    sep          DAG seg
         parallel         parallel
         (A||B||C)        (D||E)                  (F)
```

- **DAG segments** — consecutive `agent` steps. Execute as parallel wave, respecting `blockedBy` dependencies. All steps in wave with no unsatisfied `blockedBy` entries fire concurrently, up to `max_concurrent`.
- **Separator steps** — `fork`, `agent-decision`, `code-decision`, `flow-ref`. Execute one at a time, control routing.
- **Cross-segment routing** — `on_complete` and `on_error` on agent steps can jump to any step ID, including steps in different segments.

---

### Step types

Every step requires unique `id` field. `type` field optional — engine infers type from which fields are present:

| Has field | Inferred type |
|-----------|--------------|
| `question` | `fork` |
| `path` (no `agent`) | `flow-ref` |
| `branches` (no `question`) | `agent-decision` |
| `type: code` (explicit) | `code` |
| `agent` or none | `agent` |

Canonical step types: `agent`, `agent-decision`, `code`, `code-decision`, `fork`, `flow-ref`. `code` and `code-decision` never inferred. Always explicit `type:`. Use explicit `type:` when inference ambiguous.

**Removed types:** `conditional` and `agent-loop-decision` no longer exist. Parser rejects them with migration errors. Replace `conditional` with `code-decision`. Replace `agent-loop-decision` with `agent-decision` loop. See Loops.

---

#### 1. Agent step

Primary step type. Dispatches named agent with optional task and inputs.

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

**Same agent, multiple steps:** Give each step unique `id`. Agent name can repeat.

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

Presents choice to user, routes to different steps based on selection. In autonomous mode, `agent:` field provides agent to decide automatically.

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

**Fork context injection:** Chosen option, user notes, decision source (user or agent) automatically injected into branch step's system prompt — no manual wiring needed.

---

#### 3. Code decision step

Runs TypeScript handler like code step. Routes on reserved `branch` output. Deterministic routing. No agent.

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
| `id` | Yes | Unique step id. Determines handler filename. Filesystem-safe. |
| `type` | Yes | Must be `code-decision`. Not inferred. Always explicit. |
| `branches` | Yes | Map branch label → target step id. Declares ≥2 branches. |
| `inputs` | No | Map name → `${{...}}` template. Same as code step. |
| `outputs` | No | Optional data outputs. Never `branch` — reserved. |
| `target` | No | Override handler path. Skips scaffold. |
| `blockedBy` | No | Step ids that complete first. |
| `max_iterations` | No | Required when branch target points to earlier step (loop). See Loops. |
| `timeout` | No | Soft deadline ms. |

**Handler contract.** Same as code step. Same handler path `.pi/flows/handlers/<flow>/<id>.ts` or `target:`. Same `inputs`/`outputs`, soft/hard failure model, value coercion. Handler returns reserved `branch: string` key.

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

- `branch` resolves against `branches:` map. Flow routes to mapped step.
- `branch` reserved. Declaring output named `branch` → validation error.
- Data outputs follow normal code-step return contract.

| Condition | Outcome |
|-----------|---------|
| Fewer than 2 `branches` | Validation error. Use plain `code` step with `on_complete`. |
| `branch` in `outputs:` | Validation error. `branch` reserved. |
| Return omits `branch` | Soft failure naming reserved `branch` output. |
| `branch` not in `branches:` | **Hard** failure. Halts flow. Consistent with `agent-decision`. |

**Type-safe scaffold.** `/flows:generate` emits `type Branch = "auto_approve" | "needs_human" | "park";` per `code-decision`. Types return `Promise<{ branch: Branch } & Output>`. Off-map label → compile-time error. Scaffolds write `.ts.default`. Never overwrite implemented handler.

**Migrating from `conditional`:** Replace `type: conditional` with `type: code-decision`. Read `check: <stepId>.<key>` value as handler input. Return `{ branch: "present" }` or `{ branch: "absent" }`. Set `branches: { present: <present-target>, absent: <absent-target> }`. Standard fields (`artifacts`, `summary`, `files`, `status`) available as `${{result.<stepId>.<field>}}` inputs.

---

#### 4. Agent decision step

Agent evaluates options, calls `finish({ branch: "chosen" })` to select route.

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
| `max_iterations` | No | Required when branch target points to earlier step (loop). See Loops. |

Guard injects branch names into `finish` tool parameters as union type. Agent must pick one of declared branch names. `branch` not in `branches:` → flow hard-fails. `agent-decision` loops by pointing branch at earlier step. See Loops.

---

#### 5. Loops

Loop = `*-decision` node (`agent-decision` or `code-decision`) with branch target pointing to earlier step. Re-enters graph. Forms cycle. No dedicated loop step type. Loop = backward branch edge.

- `*-decision` node with branch target pointing to earlier step MUST declare `max_iterations`.
- Engine tracks per-node iteration counts. Forces exit at cap. Control falls through to next step.
- `*-decision` node with all branches forward needs no `max_iterations`.
- Dashboard ↻ iteration badge driven by `flow:loop-iteration` event. Emitted only when backward edge taken. Not inferred from `max_iterations`.

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
  on_complete: verify    # jump back to verify after fix

- id: done
  agent: summarizer
  task: Summarize the completed implementation.
```

Agent calls `finish({ branch: "fixer" })` to loop. Calls `finish({ branch: "done" })` to exit. `code-decision` loops same way — handler returns `{ branch: "fixer" }`.

**Routing node semantics.** Routing node (`fork`, `agent-decision`, `code-decision`, `flow-ref`) always executes. Own outputs always populated. Loop node outputs reflect LAST iteration. Forward branches not taken get synthetic `skipped` results. Unresolved `${{result.<id>.<field>}}` expands to empty string. Never `undefined`.

**Migrating from `agent-loop-decision`:** Replace `type: agent-loop-decision` with `type: agent-decision`. Move `loop_target` and `exit_target` into `branches:` (e.g. `branches: { rework: <loop_target>, done: <exit_target> }`). Keep `max_iterations`. Agent calls `finish({ branch: "rework" })` or `finish({ branch: "done" })`.

---

#### 6. Flow reference step

Delegate execution to another flow file, optionally using glob pattern.

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

Sub-flow results merge into parent context under sub-flow's agent step IDs.

---

#### 7. Code step

Execute TypeScript handler function in-process. No agent or LLM dispatch. `type: code` must be explicit.

```yaml
- id: validate-schema
  type: code
  inputs:
    data: ${{result.fetcher.artifacts}}
    threshold: "100"
  outputs:
    - name: is_valid
    - name: error_message
  blockedBy: [fetcher]
  on_complete: next-step
  on_error: error-handler
  timeout: 30000
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique step identifier. Filesystem-safe. Becomes handler filename. |
| `type` | Yes | Must be `code`. Not inferred — always explicit. |
| `inputs` | No | Map of name → template expression. Expanded to string at runtime. Unresolved → `""`. Never `undefined`. Input names must be valid JS identifiers. |
| `outputs` | No | List of `{ name }` objects. Names unique, valid JS identifiers. Omit for side-effect-only steps. |
| `target` | No | Override handler file path. Steps with `target` get no generated scaffold. |
| `blockedBy` | No | Array of step IDs that must complete before this step runs. |
| `on_complete` | No | Step ID to route to on success. |
| `on_error` | No | Step ID to route to on error. |
| `timeout` | No | Milliseconds. Soft deadline — aborts `ctx.signal` on expiry, yields soft failure. |

---

##### Handler contract

Handler = module default export. Signature: `async (input, ctx) => Output`.

```typescript
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

interface Input {
  data: string;        // one property per declared input — always string
  threshold: string;
}

interface Output {
  is_valid: string;    // one property per declared output
  error_message: string;
}

export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
  ctx.logger("Validating data...");
  const valid = input.data.length <= Number(input.threshold);
  ctx.setSummary(valid ? "Validation passed" : "Validation failed");
  return {
    is_valid:      String(valid),
    error_message: valid ? "" : `Exceeds threshold of ${input.threshold}`,
  };
}
```

**`CodeNodeContext` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `signal` | `AbortSignal` | Aborted when `timeout` expires. Check cooperatively in long loops. |
| `cwd` | `string` | Project root directory. |
| `logger(msg)` | `(msg: string) => void` | Stream text to step card in real time. |
| `setSummary(text)` | `(text: string) => void` | Set step summary shown after completion. |
| `flowName` | `string` | Name of the running flow. |
| `stepId` | `string` | This step's `id`. |
| `task` | `string` | The flow task string. |

**Return rules:**

- Return exactly declared outputs. All declared keys required. No extra keys.
- No `outputs:` declared → return `{}`.
- `string`: passthrough verbatim.
- `number` / `boolean` / `bigint`: coerced via `String()`.
- `object` / `array` / `null`: contract violation → soft failure naming the offending key.

**Failure modes:**

| Cause | Outcome |
|-------|---------|
| Plain `throw` (any `Error`) | `soft` — routes `on_error`, else hard-fails flow |
| Contract violation (wrong/missing output keys) | `soft` |
| Coercion failure (`object`/`array`/`null` value) | `soft` |
| Missing handler file | `soft` |
| Timeout expired | `soft` |
| `throw new FlowHardError(msg)` | `hard` — stops flow regardless of `on_error` |

No retry layer. Execution: in-process via jiti dynamic import. No subprocess.

---

##### Handler file locations

| File | Purpose |
|------|---------|
| `.pi/flows/handlers/<flow>/<id>.ts` | Real handler — implement here |
| `.pi/flows/handlers/<flow>/<id>.ts.default` | Generated scaffold — `.default` suffix makes it un-importable (inert) |

- `target:` field overrides real handler path. Steps with `target` get no generated scaffold.
- Copy `.ts.default` → remove `.default` suffix → implement.

---

##### Handler generation

Generation triggers: flow saved successfully (persisted YAML) **or** `/flows:generate <name>` command.

- Scaffold (`.ts.default`) always regenerated on trigger. Contains: `CodeNodeContext` import, `interface Input` from declared inputs, `interface Output` from declared outputs, default-export stub returning empty values, `// TODO` comment.
- Real `.ts` never touched by generation.
- `target` steps: no scaffold generated.
- Drift: if real handler's `Input`/`Output` interfaces mismatch YAML → non-fatal WARNING logged. Never blocks execution.
- Missing blockedBy step IDs: skip silently.

**Generated scaffold example:**

```typescript
// .pi/flows/handlers/my-flow/validate-schema.ts.default
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

interface Input {
  data: string;
  threshold: string;
}

interface Output {
  is_valid: string;
  error_message: string;
}

export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
  // TODO: implement
  return {
    is_valid: "",
    error_message: "",
  };
}
```

---

### Template variables

Template expressions `${{...}}` expand in `task`, `inputs` values, `question`. **Not** validated at parse time — typo silently resolves to empty string.

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

**Note:** `STEP_ID` in result references is step's `id` field, not agent name.

---

### Input wiring

Inputs: mechanism for passing data between steps. Agent declares what it expects (`inputs:` in frontmatter); flow step wires values (`inputs:` in step).

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

In implementer's system prompt:
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

Prefix input value with `file://` to inject file content directly into agent's prompt at dispatch time.

```yaml
- id: validator
  agent: validator
  inputs:
    spec_content: file://specs/api-spec.md
    output_content: file://${{result.generator.files}}
```

Rules:
- `file://${{result.STEP.files}}` — only use when step produces exactly **one** file (`files` field is comma-separated for multiple files).
- File content injected **verbatim** — never template-expanded.
- Step whose file referenced must be in `blockedBy`.
- If file does not exist at dispatch time, step fails with error.

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
