# Tools Reference

pi-flows registers a set of tools that are exposed to agents running inside flow sessions. Tools are divided into two primary contexts: the **main session** (available to the user-facing LLM) and **subagent sessions** (available only to agents spawned by a flow).

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

> **Inactive by default:** `flow_agents` and `flow_write` are registered in the main session but remain inactive until enabled via the `flows.editFlow` setting in `.pi/settings.json`. At each session start pi-flows reads `flows.editFlow` and activates or deactivates the two tools accordingly (project `.pi/settings.json`, honored only when the project is trusted, overrides global `~/.pi/agent/settings.json`; a top-level `flowsEditFlow` boolean is accepted as an alias; default when unset is disabled). Flipping the setting takes effect at the next session start. This gating mechanism prevents accidental authoring operations in non-authoring contexts.

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

## Main Session Authoring Tools (Inactive by Default)

The following tools are registered in the main session but remain inactive until enabled via the `flows.editFlow` setting in `.pi/settings.json` (e.g. `{ "flows": { "editFlow": true } }`). This gating prevents unintended authoring operations outside dedicated authoring contexts.

### `flow_agents`

Discover agents in the catalog or write a new/updated agent file. This tool combines agent discovery and agent authoring in a single interface.

**Available in:** Main session (requires `flows.editFlow: true` in settings).

**Parameters:**
```typescript
{
  op: "list" | "write";
}
```

**`op: "list"` (Agent Discovery)**

Returns the full agent catalog with metadata for each discovered agent.

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

**`op: "write"` (Agent Authoring)**

Validate and write an agent `.md` file. On validation success, writes to the discovery-derived location `.pi/flows/agents/<name>.md` (filename is derived from the agent's frontmatter `name` field) and triggers `flow:rediscover` to update the catalog.

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

On validation failure, no file is written and `written` is `false`. On success, the file is written and the catalog is updated via `flow:rediscover`.

### `flow_write`

Validate and write a flow `.yaml` file. On validation success, writes to the discovery-derived location `.pi/flows/flows/<namespace>/<name>.yaml` and triggers `flow:rediscover` to register the flow as a `/<namespace>:<name>` command. Overwriting an existing file edits it in-place (no separate edit tool needed).

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

On validation failure, no file is written and `written` is `false`. On success, the file is written to the discovery path and registered as a command.

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

Standard file-system tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) are granted to agents based on the `tools:` field in their `.md` frontmatter. The guard extension enforces that agents only call tools they declared.
