# Tools Reference

pi-flows registers tools in three distinct execution contexts. Understanding which tools are available where is critical for building agents and extensions.

```
┌───────────────────────────────────────────────────────────────────────┐
│                     Tool Execution Contexts                          │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Main Session (your interactive pi)                                   │
│  ├── flow_results      Read past flow execution results               │
│  └── subagent          Dispatch agents (single or parallel)           │
│                                                                       │
│  Agent Session (each agent runs as an in-process SDK session)         │
│  ├── finish            Submit structured results (auto-injected)      │
│  ├── skill_read        Read skill documentation files                 │
│  ├── ask_user          Prompt the user for input                      │
│  └── (declared tools)  read, write, edit, bash, grep, etc.           │
│                                                                       │
│  Architect Session (/flows:new and /flows:edit only)                  │
│  ├── agent_catalog     List all discovered agents                     │
│  ├── agent_validate    Validate agent .md syntax                      │
│  ├── agent_write       Create/update agent .md files                  │
│  ├── flow_validate     Validate flow .flow.md syntax                  │
│  ├── flow_write        Create/update flow .flow.md files              │
│  └── flow_preview      Render visual flow preview                     │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Table of Contents

- [Main Session Tools](#main-session-tools)
- [Agent Session Tools](#agent-session-tools)
- [Architect-Only Tools](#architect-only-tools)
- [Tool Context Quick Reference](#tool-context-quick-reference)

---

## Main Session Tools

These tools are registered in the main pi session. The LLM in your interactive session can call them directly.

### flow_results

Read results from completed flow executions. Results are stored as JSON files in `.pi/flows/results/`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"list" \| "summary" \| "agent"` | yes | What to retrieve |
| `flow` | `string` | for summary/agent | Flow name to query |
| `agent` | `string` | for agent action | Agent/step name within the flow |

**Actions:**

- **`list`** — List all available flow results with timestamps.
- **`summary`** — Get per-agent summaries for a flow (status, summary text, files touched).
- **`agent`** — Get full detail for a specific agent within a flow (complete output, up to 10,000 characters).

```typescript
// The LLM calls this tool automatically. Example tool call:
{
  "name": "flow_results",
  "input": {
    "action": "summary",
    "flow": "my-pipeline"
  }
}
```

### subagent

Dispatch one or more agents as in-process SDK sessions. Available in the main session for ad-hoc agent invocations outside of flows.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `"single" \| "parallel"` | yes | Dispatch mode |
| `agent` | `string` | for single | Agent name to dispatch |
| `task` | `string` | for single | Task description |
| `agents` | `Array<{agent, task}>` | for parallel | Array of agent/task pairs |

**Modes:**

- **`single`** — Dispatch one named agent with a task. Returns the agent's output.
- **`parallel`** — Dispatch multiple agents concurrently. Returns all outputs concatenated.

```typescript
// Single mode
{
  "name": "subagent",
  "input": {
    "mode": "single",
    "agent": "researcher",
    "task": "Investigate the authentication module"
  }
}

// Parallel mode
{
  "name": "subagent",
  "input": {
    "mode": "parallel",
    "agents": [
      { "agent": "researcher", "task": "Research the API layer" },
      { "agent": "researcher", "task": "Research the database layer" }
    ]
  }
}
```

---

## Agent Session Tools

These tools are available inside agent sessions — in-process SDK sessions created via `createAgentSession()` for each agent during flow execution. They run alongside whatever tools the agent declares in its `tools:` frontmatter field.

> **Important:** Agent sessions are isolated SDK contexts. They do not have access to main session tools like `flow_results` or `subagent`. The `finish` tool, `skill_read`, and `ask_user` are injected via guard and extension factories — not by the agent's `tools:` declaration.

### finish

Submit structured results at the end of agent execution. This tool is **auto-injected** into every agent — do not declare it in the agent's `tools:` field.

Agents **must** call `finish` as their last action. All subsequent tool calls after `finish` are automatically blocked — the agent is forced to stop. If an agent completes without calling `finish`, pi-flows retries the agent with a reminder (up to 3 retries).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `"complete" \| "error" \| "blocked"` | yes | Outcome status |
| `summary` | `string` | yes | Brief summary of what was accomplished |
| `files` | `Array<{path, action}>` | no | Files created, modified, or read. `action`: `"created" \| "modified" \| "read"` |
| `artifacts` | `string` | no | Optional structured data (XML or other format) |
| `branch` | `string` | decision steps only | Decision branch. Required for `agent-decision` and `agent-loop-decision` steps. Must be one of the step's declared branch names. |

```typescript
// Standard agent finish
{
  "name": "finish",
  "input": {
    "status": "complete",
    "summary": "Implemented the user authentication module",
    "files": [
      { "path": "src/auth.ts", "action": "created" },
      { "path": "src/config.ts", "action": "modified" }
    ]
  }
}

// Decision agent finish (agent-decision or agent-loop-decision step)
{
  "name": "finish",
  "input": {
    "status": "complete",
    "summary": "Tests pass, implementation is correct",
    "branch": "ready"
  }
}
```

### skill_read

Read a detail file from a skill. Skills provide framework documentation that agents can reference during execution.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skill` | `string` | yes | Skill name (e.g., `"judo-backend-docs"`) |
| `file` | `string` | yes | Detail file name (e.g., `"custom-operations.md"`) |

The file must be listed in the skill's `SKILL.md`. Skills are discovered from pi-flows' own skills directory, registered extra skills directories (via `flow:register-skills-dir`), and project-local `.pi/skills/`.

### ask_user

Prompt the user for input during agent execution. Supports selection, confirmation, and freetext input.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | `string` | yes | The question to ask |
| `type` | `"select" \| "confirm" \| "input"` | yes | Question type |
| `options` | `string[]` | for select | Options to choose from |
| `multiSelect` | `boolean` | no | Allow multiple selections |
| `allowNotes` | `boolean` | no | Prompt for optional notes after selection |
| `allowCustom` | `boolean` | no | Append "Other (describe)" option |
| `defaultValue` | `string` | no | Default value for input type |

---

## Architect-Only Tools

These tools are available only during flow design sessions — when the user runs `/flows:new` or `/flows:edit`. They are used by the flow architect agent to create and validate agents and flows.

> **Note:** These tools are not accessible from regular agents or the main session. They are passed as `customTools` to the architect's in-process SDK session — not registered as extension tools. This is because extension tools aren't available in SDK subagent sessions, so pi-flows captures the architect tool definitions at registration time and injects them via `SpawnOptions.extraCustomTools`.

### agent_catalog

List all discovered agents with their descriptions, tools, inputs, card config, source info, and architect metadata. The architect uses this to understand available agents before building flows. Agents with `source_type: "local"` are project-specific custom agents that can be read and modified with `agent_write`.

**Parameters:** None.

**Returns:** JSON array of agent summaries:

```json
[
  {
    "name": "researcher",
    "description": "Investigates the codebase",
    "tools": ["read", "grep", "bash"],
    "inputs": ["focus_area"],
    "source_type": "local",
    "source_path": "/path/to/project/.pi/flows/agents/researcher.md",
    "card": { "label": "Research", "metric": "researcher" },
    "architect": {
      "use_when": "When codebase investigation is needed",
      "produces": "Research summaries",
      "depends_on": "nothing",
      "domain": "research"
    }
  }
]
```

The `source_type` field indicates where the agent comes from:
- `"local"` — Project-specific agent in `.pi/flows/agents/` (can be modified)
- `"package"` — From a registered extension package
- `"built-in"` — Built into pi-flows

The `source_path` field is included for `"local"` and `"package"` agents, providing the file path for reading/modifying.

### agent_validate

Validate an agent `.md` file's syntax without writing to disk. Returns LSP-style diagnostics with line numbers, severity, messages, and suggestions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | yes | The agent `.md` content to validate |

### agent_write

Validate and write an agent `.md` file. Runs `agent_validate` internally first. If validation passes, writes the file and triggers agent re-discovery via `flow:rediscover`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path to write the agent file |
| `content` | `string` | yes | The agent `.md` content |

### flow_validate

Validate a flow `.flow.md` file's syntax without writing to disk. Checks frontmatter, step definitions, dependency graph, and agent references. Returns diagnostics.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | yes | The flow `.flow.md` content to validate |

### flow_write

Validate and write a flow `.flow.md` file. Runs `flow_validate` internally first. If validation passes, writes the file.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path to write the flow file |
| `content` | `string` | yes | The flow `.flow.md` content |

### flow_preview

Render a visual preview of a flow showing steps, dependencies, and agent assignments as formatted text.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | yes | The flow `.flow.md` content to preview |

---

## Tool Context Quick Reference

| Tool | Main Session | Agent Session | Architect Session |
|------|:---:|:---:|:---:|
| `flow_results` | ✓ | | |
| `subagent` | ✓ | | |
| `finish` | | ✓ (guard-injected) | |
| `skill_read` | | ✓ | |
| `ask_user` | | ✓ | |
| `read`, `write`, `edit`, `bash`, etc. | | ✓ (if declared) | |
| `agent_catalog` | | | ✓ (customTools) |
| `agent_validate` | | | ✓ (customTools) |
| `agent_write` | | | ✓ (customTools) |
| `flow_validate` | | | ✓ (customTools) |
| `flow_write` | | | ✓ (customTools) |
| `flow_preview` | | | ✓ (customTools) |

> **Injection mechanism:** `finish` is registered by `createGuardExtension({ requireFinish: true })` inside the agent's in-process SDK session. Architect tools are passed as `SpawnOptions.extraCustomTools` — an array of tool definitions captured by the main session at startup time and injected into the architect agent's session.
