# Tools Reference

pi-flows registers a set of tools that are exposed to agents running inside flow sessions. Tools are divided into three contexts: the **main session** (available to the user-facing LLM), **subagent sessions** (available only to agents spawned by a flow), and **architect-only** (used exclusively by the flow-architect agent).

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

> **"Architect only"** means these tools are available inside the `flow-architect` agent's session and in any other agent session launched via the architect subprocess. They are **not** available to ordinary flow agents or the main LLM session.

External packages can add tools to subagent sessions via `flow:register-tool`. See [events-api.md](events-api.md#flowregister-tool).

---

## Main Session Tools

### `ask_user`

Ask the user a structured question from within an agent. Supports free-text input, single-select, and yes/no confirm.

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

For `confirm`, `answer` is `true` or `false`. For `multiSelect`, `answer` is an array of selected strings. For `allowCustom` with "Other (describe)", the agent receives the user's free-text description.

**Usage in agent system prompt:** Agents can call `ask_user` to gather clarification mid-task. In autonomous mode, `ask_user` is blocked in subagent sessions — agents must make decisions autonomously.

---

### `skill_read`

Read a topic file from a registered skill bundle. Skills provide on-demand reference documentation without bloating every agent's system prompt.

**Available in:** Main session, all subagent sessions.

**Parameters:**
```typescript
{
  skill: string;  // Skill name (e.g., "my-backend-docs")
  file:  string;  // Topic file name listed in SKILL.md (e.g., "api-patterns.md")
}
```

**Returns:** Raw file content as text, or an error string if the skill or file is not found.

**How skills are discovered:**
1. Extra skills directories (registered via `flow:register-skills-dir`) — searched first.
2. pi-flows package `skills/` directory.

A skill directory must contain `SKILL.md` with a `files:` list. `skill_read` validates that `file` appears in that list before reading.

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

The `SKILL.md` index is automatically injected into the agent's system prompt when `skills:` is declared. Individual topic files are read on-demand.

---

### `subagent`

Run a named agent as a subprocess. This is the internal tool that powers agent steps in flows. It is also available in the main session for one-off agent dispatch.

**Available in:** Main session.

**Parameters:**
```typescript
{
  agent:  string;   // Agent name (must be in the catalog)
  task:   string;   // Task description
  inputs?: Record<string, string>;  // Named inputs (key → value)
}
```

**Returns:** The agent's `finish` call result, including `status`, `summary`, `files`, and typed outputs.

---

## Subagent Session Tools

### `finish`

Submit the agent's final structured result. **Every agent must call `finish` as its last action.** The tool is registered per-session by the guard extension — it is never available in the main session.

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

**Branch routing:** For `agent-decision` and `agent-loop-decision` steps, the guard injects a `branch` parameter whose allowed values are the defined branch names. The agent's `branch` choice is used by the engine to route to the next step.

**Typed outputs:** If the agent declares `outputs:` in its frontmatter, those names are added as optional string parameters on `finish`. Downstream steps can read them via `${{result.STEP_ID.outputName}}`.

**Post-finish blocking:** Once `finish` is called, the guard blocks any further tool calls. The engine extracts the result from the `finish` call parameters.

---

## Architect-Only Tools

These tools are available only to `flow-architect` (and agents it spawns), registered via the `subagentOnlyPi` shim. They **do not appear** in the main session's system prompt.

### `agent_catalog`

List all discovered agents with full metadata. Used by the architect to understand what agents are available before designing a flow.

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
- `"package"` — from a registered dependent package
- `"built-in"` — from pi-flows itself

---

### `agent_write`

Validate and write an agent `.md` file. Validates the content first; if validation passes, writes the file and triggers re-discovery via `flow:rediscover`.

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

Validate and write a flow `.yaml` file. Validates the YAML structure and checks that all referenced agent names exist in the catalog. Triggers `flow:rediscover` on success.

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
- All step IDs are unique
- All `agent:` references resolve to known agent names
- All `blockedBy:` references point to earlier agent steps
- All `branches:` target step IDs exist in the flow
- All `loop_target` / `exit_target` step IDs exist
- Warning if declared agent `inputs:` are not wired in the flow step
- Warning for steps that reference undefined step IDs in template variables

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

Standard file-system tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) are granted to agents based on the `tools:` field in their `.md` frontmatter. The guard extension enforces that agents only call tools they declared.
