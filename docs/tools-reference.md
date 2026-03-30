# Tools Reference

All tools registered by pi-flows, organized by execution context. Using a tool in the wrong context will either silently fail or throw an error — understanding context is critical.

---

## Execution Contexts

pi-flows has three distinct execution contexts, each with its own tool set:

| Context | Where code runs | Who uses it |
|---------|----------------|-------------|
| **Main session** | The user-facing pi session | The main session LLM; extension code |
| **Agent session** | A spawned subprocess per agent step | Agent prompts in flow steps |
| **Architect session** | A specialized subprocess for flow design | The Flow Architect (`/flows:new`) |

Tools are scoped to a context. The main session LLM can call `subagent` but cannot call `finish`. An agent subprocess can call `finish` but cannot call `subagent`.

---

## Main Session Tools

Available to the main session LLM and extension code. These tools are registered globally on `pi` and are never available inside agent subprocesses.

### `subagent`

Dispatch one or more agents as subprocesses. This is the main session's mechanism for invoking the flow engine directly (outside of a full flow run).

**Parameters:**

```typescript
{
  mode: "single" | "parallel";

  // Single mode:
  agent?: string;   // Agent name
  task?: string;    // Task description

  // Parallel mode:
  agents?: Array<{
    agent: string;
    task: string;
  }>;
}
```

**Returns:** The raw agent output(s) as text.

**Single mode example:**

```json
{
  "mode": "single",
  "agent": "researcher",
  "task": "Investigate the authentication module"
}
```

**Parallel mode example:**

```json
{
  "mode": "parallel",
  "agents": [
    { "agent": "researcher", "task": "Investigate auth module" },
    { "agent": "summarizer", "task": "Summarize the test suite" }
  ]
}
```

> **Note:** `subagent` spawns agents directly without a dashboard or flow result persistence. Use flows (via `/flow-name`) for full orchestration with DAG scheduling, result storage, and the live dashboard.

---

### `flow_results`

Read flow execution results. The main session LLM uses this to access results from previously run flows.

**Parameters:**

```typescript
{
  action: "list" | "summary" | "agent";
  flow?: string;   // Required for "summary" and "agent" actions
  agent?: string;  // Required for "agent" action (the step/agent name within the flow)
}
```

**Actions:**

| Action | Returns |
|--------|---------|
| `list` | All available flow results with timestamps |
| `summary` | Per-step summaries for a specific flow |
| `agent` | Full output for a specific agent step within a flow |

**`list` example response:**

```
Available flow results:

• judo:apply    (2025-03-15 14:22:01)
• judo:research (2025-03-14 09:10:45)
```

**`summary` example:**

```json
{ "action": "summary", "flow": "judo:apply" }
```

**`agent` example:**

```json
{ "action": "agent", "flow": "judo:apply", "agent": "developer" }
```

> **Auto-availability:** `flow_results` is always registered by pi-flows. There is nothing to configure. The main session LLM calls it automatically when users ask about previous flow work.

---

## Agent Session Tools

Available inside agent subprocesses spawned by flow steps. Declared in the agent's `tools:` frontmatter field (except `finish`, which is auto-injected).

### Built-in File & Shell Tools

These map directly to pi-coding-agent's SDK tools:

| Tool | Frontmatter name | Description |
|------|-----------------|-------------|
| `read` | `read` | Read text files and images |
| `write` | `write` | Write or create files |
| `edit` | `edit` | Surgical text replacement in existing files |
| `bash` | `bash` | Execute shell commands |
| `grep` | `grep` | Regex search over file contents (supports `glob:` filter) |
| `find` | `find` | Find files in directory trees (supports glob patterns) |
| `ls` | `ls` | List directory contents |

**Access control:** If the agent's frontmatter has an `access:` block, `read` and `write` are restricted to the declared glob patterns. `bash` commands matching `deny:` patterns are blocked.

---

### `skill_read`

Read a detail file from a skill. Skills are documentation packages injected into agent sessions to provide domain knowledge.

**Frontmatter:** `skill_read`

**Parameters:**

```typescript
{
  skill: string;  // Skill name (e.g., "judo-backend-docs")
  file: string;   // Detail file name listed in SKILL.md (e.g., "api-reference.md")
}
```

**Returns:** The content of the requested detail file.

**Error cases:**
- Skill not found → `Error: Skill 'X' not found`
- File not listed in `SKILL.md` → `Error: File 'X' is not listed in skill/SKILL.md`
- File listed but missing → `Error: File 'X' listed in SKILL.md but not found`

**How it works:** The `SKILL.md` file in each skill directory is injected into the agent's system prompt when the agent declares the skill. The `skill_read` tool lets the agent read individual detail files on demand, keeping the system prompt lean.

**Example agent frontmatter:**

```yaml
skills: judo-backend-docs
tools: read, write, skill_read
```

**Example call:**

```json
{ "skill": "judo-backend-docs", "file": "api-reference.md" }
```

---

### `finish`

Submit the agent's structured result and terminate the session. **Auto-injected by pi-flows — do not declare in `tools:`.**

**Parameters:**

```typescript
{
  summary: string;     // Human-readable summary of what was done
  status?: "complete" | "error" | "blocked";  // Default: "complete"
  files?: Array<{
    path: string;
    action: "created" | "modified" | "read";
  }>;
  artifacts?: string;  // Structured XML data for downstream steps
  branch?: string;     // For decision/loop agents: the chosen branch name
}
```

The `finish` call produces a `<result>` XML envelope that is parsed by pi-flows:

```xml
<result status="complete">
  <summary>Implemented the authentication module.</summary>
  <files>
    <file path="src/auth.ts" action="created"/>
    <file path="tests/auth.test.ts" action="created"/>
  </files>
  <artifacts>
    <test_count>12</test_count>
  </artifacts>
</result>
```

**Behavior:** Any tool calls made after `finish` are blocked by the guard. The agent's session terminates immediately after `finish` executes.

**For decision agents** (`agent-decision` and `agent-loop-decision` steps), the `branch` field is required:

```typescript
// Agent deciding between "needs-work" and "ready":
{ summary: "Code quality is sufficient.", branch: "ready" }
```

---

### `ask_user`

Prompt the user for input mid-execution. Only works for agents declared as `interactive: true` in their frontmatter. For non-interactive agents, calling `ask_user` will hang indefinitely.

**Frontmatter:** `ask_user` (also requires `interactive: true`)

**Parameters:**

```typescript
{
  question: string;
  type: "select" | "confirm" | "input";
  options?: string[];       // For "select" type
  multiSelect?: boolean;    // Allow multiple selections
  allowNotes?: boolean;     // Prompt for optional notes after selection
  allowCustom?: boolean;    // Append "Other (describe)" option
  defaultValue?: string;    // For "input" type
}
```

**Returns:**

```typescript
{ answer: string | string[]; notes?: string }
```

**Example (inside agent system prompt context):**

```
Ask the user which modules to include using ask_user with type "select" and 
options: "auth", "payments", "notifications".
```

---

### Extension Tools

Registered by dependent packages via [`flow:register-tool`](events-api.md#flowregister-tool). These tools are declared in agent frontmatter like any built-in tool and become available to all spawned agent sessions.

**Example:** `model_cli` registered by pi-judo:

```yaml
# Agent frontmatter
tools: read, write, model_cli
```

The agent can then call `model_cli` to interact with the domain model.

---

## Architect Session Tools

Available exclusively to the Flow Architect agent during `/flows:new` and `/flows:edit` sessions. These tools help the architect understand the available agents, validate flow designs, and write files.

> **Not for agent frontmatter:** These tools are main-session-only and should not appear in agent `tools:` declarations. The guard will block them in agent subprocesses.

### `agent_catalog`

List all discovered agents with their descriptions, tools, inputs, card config, source info, and architect metadata.

**Parameters:** `{}` (no parameters)

**Returns:** JSON array of agent entries:

```typescript
Array<{
  name: string;
  description: string;
  tools: string[];
  inputs?: string[];
  card?: { type?: string; label?: string; metric?: string };
  source_type: "local" | "package" | "built-in";
  source_path?: string;
  architect: {
    use_when?: string;   // When to use this agent
    produces?: string;   // What the agent outputs
    depends_on?: string; // What it needs as input
    domain?: string;     // Agent's domain
  };
}>
```

`source_type` values:
- `"local"` — from the project's `.pi/flows/agents/` (can be edited with `agent_write`)
- `"package"` — from a registered package directory
- `"built-in"` — from pi-flows itself

---

### `agent_validate`

Validate agent `.md` content without writing to disk. Returns LSP-style diagnostics.

**Parameters:**

```typescript
{
  content: string;  // The agent .md content to validate
}
```

**Returns:**

```typescript
{
  valid: boolean;
  diagnostics: Array<{
    line: number;
    severity: "error" | "warning";
    message: string;
    suggestion?: string;
  }>;
}
```

---

### `agent_write`

Validate and write an agent `.md` file. Runs `agent_validate` first. On success, writes the file and triggers agent re-discovery. On failure, returns validation errors without writing.

**Parameters:**

```typescript
{
  path: string;     // Absolute or relative path to write the agent file
  content: string;  // The agent .md content
}
```

**Returns:**

```typescript
{
  written: boolean;
  path: string;
  diagnostics?: Array<{ line, severity, message, suggestion? }>;
}
```

---

### `flow_validate`

Validate flow YAML content without writing to disk. Checks top-level fields, step syntax, agent references, and template variable usage.

**Parameters:**

```typescript
{
  content: string;  // The flow YAML content to validate
}
```

**Returns:** Same shape as `agent_validate` — `{ valid, diagnostics }`.

---

### `flow_write`

Validate and write a flow `.yaml` file. Runs `flow_validate` first. On success, writes the file and triggers flow re-discovery (registering a new slash command). On failure, returns validation errors.

**Parameters:**

```typescript
{
  path: string;     // Absolute or relative path to write the flow file
  content: string;  // The flow YAML content
}
```

**Returns:**

```typescript
{
  written: boolean;
  path: string;
  diagnostics?: Array<{ line, severity, message, suggestion? }>;
}
```

---

### `flow_preview`

Render a text preview of a flow showing name, description, steps, dependency arrows, and custom agents. Presents a choice to the user: Run, Save & Run, Replan, or Cancel.

**Parameters:**

```typescript
{
  content: string;  // Flow .md content to preview
  name?: string;    // Optional flow name override for display
}
```

**Returns:** Result of the user's selection (`"run"`, `"save_and_run"`, `"replan"`, or `"cancel"`).

This tool is typically the final step in the Flow Architect's design loop — it lets the user review the generated flow before committing.
