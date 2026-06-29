# Tools Reference

pi-flows registers tools exposed to agents running inside flow sessions. Tools divided into two contexts: **main session** (available to user-facing LLM), **subagent sessions** (available only to agents spawned by flow).

---

## Overview

| Tool | Context | Registered by |
|------|---------|--------------|
| `ask_user` | Main session | `registerAskUserTool` |
| `skill_read` | Main session | `registerSkillReadTool` |
| `subagent` | Main session | `registerSubagentTool` |
| `finish` | Subagent sessions | Guard extension (per-session) |
| `flow_agents` | Main session (inactive by default) | `registerFlowAgentsTool` |
| `flow_write` | Main session (inactive by default) | `registerFlowWriteTool` |

> **Inactive by default:** `flow_agents` and `flow_write` registered in main session, inactive until `flows.editFlow` setting enabled in `.pi/settings.json`. Session start reads `flows.editFlow`, activates/deactivates both tools via `pi.setActiveTools()`. Project `.pi/settings.json` (only when project trusted) overrides global `~/.pi/agent/settings.json`. Top-level `flowsEditFlow` boolean = alias for `flows.editFlow`. Default unset = disabled. Setting change takes effect next session start (restart needed). Gating prevents unintended authoring outside dedicated contexts.
>
> **Toggle live:** `/flows:edit-mode <on|off>` toggles this. Inbound event `flow:set-edit-mode { enabled: boolean }` does same. Writes `flows.editFlow` to project `.pi/settings.json`, reconciles `flow_agents`/`flow_write`. Command path reloads (live this session). Event path: tools immediate, skill visibility next session. `manage-flows` skill prompt visibility coupled to same toggle: on -> `disable-model-invocation`=false (visible), off -> hidden. See flow-authoring.md, events-api.md.

The main session also exposes `flow_results` (registered by flow-context) for read-only inspection of flow results and run state — see below.

External packages can add tools to subagent sessions via `flow:register-tool`. See [events-api.md](events-api.md#flowregister-tool).

---

## Main Session Tools

### `ask_user`

Ask user structured question from within agent. Supports free-text input, single-select, yes/no confirm.

**Available in:** Main session, all subagent sessions.

**Parameters:**
```typescript
{
  question:     string;                            // The question text
  type:         "input" | "select" | "confirm";   // Interaction type
  options?:     string[];                          // Choices for "select"
  multiSelect?: boolean;                           // Allow multiple selections (select only)
  allowCustom?: boolean;                           // Append "Other (describe)" option (select only)
  defaultValue?: string;                           // Pre-filled default (input only)
}
```

**Returns:**
```typescript
{ answer: string | string[] | boolean }
```

For `confirm`: `answer` is `true` or `false`. For `multiSelect`: `answer` is array of selected strings. For `allowCustom` with "Other (describe)": agent receives user's free-text description.

**Usage in agent system prompt:** Agents can call `ask_user` to gather clarification mid-task. In autonomous mode, `ask_user` blocked in subagent sessions — agents must decide autonomously.

---

### `skill_read`

Read topic file from registered skill bundle. Skills provide on-demand reference documentation without bloating every agent's system prompt.

**Available in:** Main session, all subagent sessions.

**Parameters:**
```typescript
{
  skill: string;  // Skill name (e.g., "my-backend-docs")
  file:  string;  // Topic file name listed in SKILL.md (e.g., "api-patterns.md")
}
```

**Returns:** Raw file content as text, or error string if skill or file not found.

**How skills discovered:**
1. Extra skills directories (registered via `flow:register-skills-dir`) — searched first.
2. pi-flows package `skills/` directory.

Skill directory must contain `SKILL.md` with `files:` list. `skill_read` validates `file` appears in list before reading.

**Usage pattern:**
```markdown
---
name: my-agent
skills: my-backend-docs
---
You have access to backend documentation. Use `skill_read` to look up:
- skill: my-backend-docs
- file: (see SKILL.md for available files)
```

`SKILL.md` index automatically injected into agent's system prompt when `skills:` declared. Individual topic files read on-demand.

---

### `subagent`

Run named agent as subprocess. Internal tool powering agent steps in flows. Also available in main session for one-off agent dispatch.

**Available in:** Main session.

**Parameters:**
```typescript
{
  agent:  string;   // Agent name (must be in the catalog)
  task:   string;   // Task description
  inputs?: Record<string, string>;  // Named inputs (key → value)
}
```

**Returns:** Agent's `finish` call result: `status`, `summary`, declared typed outputs (stored under `outputs` in real JSON types).

---

### `flow_results`

Read-only inspection of flow results and live/historical run state (registered by flow-context). Cannot mutate a run.

**Available in:** Main session.

```typescript
{
  action: "list" | "summary" | "agent" | "runs";
  flow?:  string;   // required for "summary"/"agent"; optional for "runs"
  agent?: string;   // required for "agent"
}
```

- `list` — list stored flow results.
- `summary` — per-agent summaries for a flow; each shows `status`, `summary`, `Outputs:` (declared output names).
- `agent` — full detail for one agent/step in a flow.
- `runs` — read-only run-state seam. No args: lists this session's runs (live + finished) with per-node counts. With `flow`: latest run's per-node state (`pending`/`running`/`finished` + result status/summary), merging produced `outputs` from the completed-run result JSON. Serves live + historical runs.

---

## Main Session Authoring Tools (Inactive by Default)

Tools registered in main session, inactive until `flows.editFlow: true` set in `.pi/settings.json` (e.g. `{ "flows": { "editFlow": true } }`). Gating prevents unintended authoring outside dedicated contexts.

### `flow_agents`

Discover agents in catalog or write new/updated agent file. Combines agent discovery and authoring in single interface.

**Available in:** Main session (requires `flows.editFlow: true` in settings).

**Parameters:**
```typescript
{
  op: "list" | "write";
}
```

**`op: "list"` (Agent Discovery)**

Returns full agent catalog with metadata for each discovered agent.

**Returns:** JSON array of agent catalog entries:
```typescript
Array<{
  name:        string;
  description: string;
  tools:       string[];
  inputs?:     string[];       // declared input names
  outputs?:    Array<{ name: string; description?: string }>;
  card?:       { type?: string; label?: string; metric?: string };
  source_type: "local" | "package" | "built-in";
  source_path?: string;        // only for "local" agents
  architect: {
    use_when?:   string;
    produces?:   string;
    depends_on?: string;
    domain?:     string;
  };
}>
```

`source_type` classification:
- `"local"` — project-specific agents in `.pi/flows/agents/` (can read and modify)
- `"package"` — from registered dependent package
- `"built-in"` — from pi-flows itself

**`op: "write"` (Agent Authoring)**

Validate and write agent `.md` file. On validation success: writes to `.pi/flows/agents/<name>.md` (filename from agent's frontmatter `name` field) and triggers `flow:rediscover` to update catalog.

**Additional parameters (when `op: "write"`):**
```typescript
{
  op:      "write";
  content: string;  // Agent .md file content (frontmatter + body)
}
```

**Returns:**
```typescript
{
  written:     boolean;   // false if validation failed
  diagnostics: Diagnostic[];  // validation errors/warnings
}
```

`Diagnostic` shape:
```typescript
{
  line:        number;
  severity:    "error" | "warning";
  message:     string;
  suggestion?: string;
}
```

On validation failure: no file written, `written` is `false`. On success: file written and catalog updated via `flow:rediscover`.

### `flow_write`

Validate and write flow `.yaml` file. On validation success: writes to `.pi/flows/flows/<namespace>/<name>.yaml` and triggers `flow:rediscover` to register flow as `/<namespace>:<name>` command. Overwriting existing file edits in-place (no separate edit tool).

**Available in:** Main session (requires `flows.editFlow: true` in settings).

**Parameters:**
```typescript
{
  namespace?: string;  // Flow namespace (default: "custom"). Auto-registers as /<namespace>:<name> command
  name:       string;  // Flow name. Determines filename in .pi/flows/flows/<namespace>/<name>.yaml
  content:    string;  // Flow YAML content
}
```

**Returns:**
```typescript
{
  written:     boolean;   // false if validation failed
  diagnostics: Diagnostic[];  // validation errors/warnings
}
```

`Diagnostic` shape:
```typescript
{
  line:        number;
  severity:    "error" | "warning";
  message:     string;
  suggestion?: string;
}
```

On validation failure: no file written, `written` is `false`. On success: file written to discovery path and registered as command.

**Validation checks performed:**
- Required fields present (`name`, `description`, `steps`)
- All step IDs unique
- All `agent:` references resolve to known agent names
- All `blockedBy:` references point to earlier agent steps
- All `branches:` target step IDs exist in flow
- All `loop_target` / `exit_target` step IDs exist
- Warning if declared agent `inputs:` not wired in flow step
- Warning for steps referencing undefined step IDs in template variables

---

## Subagent Session Tools

### `finish`

Submit agent's final structured result. **Every agent must call `finish` as last action.** Tool registered per-session by guard extension — never available in main session.

**Parameters:**
```typescript
{
  status:    "complete" | "error" | "blocked";
  summary:   string;    // Brief summary of what was accomplished or what went wrong
  branch?:   string;    // Required for agent-decision steps
  // ...typed output fields declared in agent's outputs frontmatter (any JSON type)
}
```

**Branch routing:** For `agent-decision` steps, guard injects `branch` parameter whose allowed values are defined branch names. Agent's `branch` choice used by engine to route to next step.

**Typed outputs:** If agent declares `outputs:` in frontmatter, those names added as parameters on `finish`, typed to their declared type (`string` by default; `number`/`boolean`/`object`/`array` when non-string). The schema validates the emitted value; the engine stores it typed under the result's `outputs`. Downstream steps read via `${{result.STEP_ID.outputName}}`.

**Post-finish blocking:** Once `finish` called, guard blocks any further tool calls. Engine extracts result from `finish` call parameters.

---

## Tool Availability Matrix

| Tool | Main session LLM | Flow agent | External package agent |
|------|:---:|:---:|:---:|
| `ask_user` | ✓ | ✓ (blocked in autonomous) | ✓ |
| `skill_read` | ✓ | ✓ | ✓ |
| `subagent` | ✓ | — | — |
| `flow_agents` | ✓ (inactive unless `flows.editFlow`) | — | — |
| `flow_write` | ✓ (inactive unless `flows.editFlow`) | — | — |
| `finish` | — | ✓ | ✓ |
| `read/write/edit/grep/…` | ✓ (always) | declared in frontmatter | declared in frontmatter |
| Custom (via `flow:register-tool`) | — | ✓ | ✓ |

Standard filesystem tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) granted to agents based on `tools:` field in `.md` frontmatter. Guard extension enforces agents only call tools they declared.
