# Tools Reference

pi-flows registers tools exposed to agents running inside flow sessions. Tools divided into three contexts: **main session** (available to user-facing LLM), **subagent sessions** (available only to agents spawned by flow), **architect-only** (used exclusively by flow-architect agent).

---

## Overview

| Tool | Context | Registered by |
|------|---------|--------------|
| `ask_user` | Main session | `registerAskUserTool` |
| `skill_read` | Main session | `registerSkillReadTool` |
| `subagent` | Main session | `registerSubagentTool` |
| `finish` | Subagent sessions | Guard extension (per-session) |
| `agent_catalog` | Architect only | `registerAgentCatalogTool` |
| `agent_write` | Architect only | `registerAgentWriteTool` |
| `flow_write` | Architect only | `registerFlowWriteTool` |

> **"Architect only"** means tools available inside `flow-architect` agent's session and in any other agent session launched via architect subprocess. **Not** available to ordinary flow agents or main LLM session.

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

**Returns:** Agent's `finish` call result, including `status`, `summary`, `files`, typed outputs.

---

## Subagent Session Tools

### `finish`

Submit agent's final structured result. **Every agent must call `finish` as last action.** Tool registered per-session by guard extension — never available in main session.

**Parameters:**
```typescript
{
  status:    "complete" | "error" | "blocked";
  summary:   string;    // Brief summary of what was accomplished or what went wrong
  files:     Array<{ path: string; action: "created" | "modified" | "read" }>;
  artifacts?: string;   // Optional structured data (XML or other)
  branch?:   string;    // Required for agent-decision and agent-loop-decision steps
  // ...typed output fields declared in agent's outputs frontmatter
}
```

**Branch routing:** For `agent-decision` and `agent-loop-decision` steps, guard injects `branch` parameter whose allowed values are defined branch names. Agent's `branch` choice used by engine to route to next step.

**Typed outputs:** If agent declares `outputs:` in frontmatter, those names added as optional string parameters on `finish`. Downstream steps read via `${{result.STEP_ID.outputName}}`.

**Post-finish blocking:** Once `finish` called, guard blocks any further tool calls. Engine extracts result from `finish` call parameters.

---

## Architect-Only Tools

Tools available only to `flow-architect` (and agents it spawns), registered via `subagentOnlyPi` shim. **Do not appear** in main session's system prompt.

### `agent_catalog`

List all discovered agents with full metadata. Used by architect to understand what agents are available before designing flow.

**Parameters:** `{}` (no parameters)

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
- `"local"` — project-specific agents in `.pi/flows/agents/` (can be read and modified)
- `"package"` — from registered dependent package
- `"built-in"` — from pi-flows itself

---

### `agent_write`

Validate and write agent `.md` file. Validates content first; if validation passes, writes file and triggers re-discovery via `flow:rediscover`.

**Parameters:**
```typescript
{
  path:    string;  // Absolute or relative path for the .md file
  content: string;  // Agent .md file content (frontmatter + body)
}
```

**Returns:**
```typescript
{
  written:     boolean;
  path:        string;
  diagnostics: Diagnostic[];  // validation errors/warnings
  error?:      string;        // filesystem error if write failed
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

---

### `flow_write`

Validate and write flow `.yaml` file. Validates YAML structure, checks all referenced agent names exist in catalog. Triggers `flow:rediscover` on success.

**Parameters:**
```typescript
{
  path:    string;  // Absolute or relative path for the .yaml file
  content: string;  // Flow YAML content
}
```

**Returns:**
```typescript
{
  written:     boolean;
  path:        string;
  diagnostics: Diagnostic[];
  error?:      string;
}
```

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

## Tool Availability Matrix

| Tool | Main session LLM | Flow agent | Architect agent | External package agent |
|------|:---:|:---:|:---:|:---:|
| `ask_user` | ✓ | ✓ (blocked in autonomous) | ✓ | ✓ |
| `skill_read` | ✓ | ✓ | ✓ | ✓ |
| `subagent` | ✓ | — | — | — |
| `finish` | — | ✓ | ✓ | ✓ |
| `agent_catalog` | — | — | ✓ | — |
| `agent_write` | — | — | ✓ | — |
| `flow_write` | — | — | ✓ | — |
| `read/write/edit/grep/…` | ✓ (always) | declared in frontmatter | declared in frontmatter | declared in frontmatter |
| Custom (via `flow:register-tool`) | — | ✓ | ✓ | ✓ |

Standard filesystem tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) granted to agents based on `tools:` field in `.md` frontmatter. Guard extension enforces agents only call tools they declared.
