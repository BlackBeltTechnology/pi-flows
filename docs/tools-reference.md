# Tools Reference

pi-flows registers a set of tools that are exposed to agents running inside flow sessions. Tools are divided into two primary contexts: the **main session** (available to the user-facing LLM) and **subagent sessions** (available only to agents spawned by a flow).

---

## Overview

| Tool | Context | Registered by |
|------|---------|--------------|
| `ask_user` | Main session | `registerAskUserTool` |
| `subagent` | Main session | `registerSubagentTool` |
| `finish` | Subagent sessions | Guard extension (per-session) |
| `flow_agents` | Main session (inactive by default) | `registerFlowAgentsTool` |
| `flow_write` | Main session (inactive by default) | `registerFlowWriteTool` |

> **Inactive by default:** `flow_agents` and `flow_write` are registered in the main session but remain inactive until enabled via the `flows.editFlow` setting in `.pi/settings.json`. At each session start pi-flows reads `flows.editFlow` and activates or deactivates the two tools accordingly (project `.pi/settings.json`, honored regardless of project trust, overrides global `~/.pi/agent/settings.json`; a top-level `flowsEditFlow` boolean is accepted as an alias; default when unset is disabled). The setting is also re-read at the start of each agent turn, so an out-of-band change (e.g. hand-editing `.pi/settings.json` while a session is running) flips the two **tools** on the session's next agent turn without a restart; the re-check is change-gated (no effect when the resolved value is unchanged). The `manage-flows` **skill**'s prompt-visibility does not update this way — it still applies on the next session start / reload (see the toggle note below). This gating mechanism prevents accidental authoring operations in non-authoring contexts.
>
> **Toggle it live:** run `/flows:edit-mode <on|off>` (or have a dashboard emit the inbound `flow:set-edit-mode { enabled: boolean }` event). This writes `flows.editFlow` to the project `.pi/settings.json`, reconciles `flow_agents`/`flow_write` to match, and (command path only) reloads so the change is active in the current session. The `manage-flows` skill's prompt visibility is coupled to the same toggle — edit-mode on makes the skill visible (frontmatter `disable-model-invocation: false`), off hides it from the prompt. The event path updates tools immediately but applies skill visibility on the next session start. See [flow-authoring.md](flow-authoring.md) and [events-api.md](events-api.md).

The main session also exposes `flow_results` (registered by the flow-context sub-extension) for read-only inspection of flow results and run state — see below.

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

### Skills (read-based, no dedicated tool)

pi-flows has **no `skill_read` tool**. Skills follow pi's own mechanism: when an
agent declares `skills:`, each declared skill is resolved (via pi's
`loadSkillsFromDir`) and **advertised** in the agent's system prompt with pi's
`formatSkillsForPrompt` — `<name>`, `<description>`, and `<location>` (the
absolute `SKILL.md` path). The agent then loads `SKILL.md` and any topic files it
references **on demand with the standard `read` tool** (progressive disclosure).

Because a flow agent may not declare `read`, and may sandbox it with
`access.read`, `spawnAgent` makes skills reachable automatically:

1. **Auto-grants `read`** — if the agent declares `skills:` but not `read`,
   `read` is added to its effective tools.
2. **Whitelists the skill dirs** — each resolved skill directory is added to the
   agent's `access.read` globs, so a restrictive read sandbox still permits the
   advertised skill files (and nothing else outside the sandbox).

**Skill discovery order** (used to resolve declared skill names):
1. Extra skills directories (registered via `flow:register-skills-dir`) — searched first.
2. pi-flows package `skills/` directory.

**Usage:**
```markdown
---
name: my-agent
skills: my-backend-docs
tools: grep, find        # `read` is auto-added because `skills:` is set
---
Consult the my-backend-docs skill (see its <location>) before implementing.
```

> Do **not** list `skill_read` in `tools:` — it does not exist and validation
> rejects it. Reading skill files is done with `read`.

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

**Returns:** The agent's `finish` call result: `status`, `summary`, and the declared typed outputs (stored under `outputs` in their real JSON types).

---

### `flow_results`

Read-only inspection of flow execution results and live/historical run state. The tool can only read — it has no operation that resumes, re-routes, or otherwise mutates a run.

**Available in:** Main session.

**Parameters:**
```typescript
{
  action: "list" | "summary" | "agent" | "runs";
  flow?:  string;   // required for "summary" and "agent"; optional for "runs"
  agent?: string;   // required for "agent"
}
```

**Actions:**
- `list` — list the available stored flow results.
- `summary` — per-agent summaries for a flow's run. Each entry shows the step's `status`, `summary`, and `Outputs:` (the declared output names it produced).
- `agent` — full detail for one agent/step within a flow.
- `runs` — the read-only run-state seam. With no `flow`, lists this session's runs (live and finished) with per-node counts. With a `flow` name, details that flow's latest run as per-node state — each node reported as `pending`/`running`/`finished` together with its result status and summary — merging the produced `outputs` from the completed-run result JSON. Serves both live and historical runs.

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

Validate and write a flow definition. On validation success, writes to the discovery-derived location `.pi/flows/flows/<namespace>/<name>/flow.yaml` — each flow is a self-contained directory whose code-node handlers are co-located beside `flow.yaml` — and triggers `flow:rediscover` to register the flow as a `/<namespace>:<name>` command. Overwriting an existing file edits it in-place (no separate edit tool needed).

**Available in:** Main session (requires `flows.editFlow: true` in settings).

**Parameters:**
```typescript
{
  namespace?: string;  // Flow namespace (default: "custom"). Auto-registers as /<namespace>:<name> command
  name:       string;  // Flow name. Determines directory in .pi/flows/flows/<namespace>/<name>/flow.yaml
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
  branch?:   string;    // Required for agent-decision steps
  // ...typed output fields declared in agent's outputs frontmatter (any JSON type)
}
```

**Branch routing:** For `agent-decision` steps, the guard injects a `branch` parameter whose allowed values are the defined branch names. The agent's `branch` choice is used by the engine to route to the next step.

**Typed outputs:** If the agent declares `outputs:` in its frontmatter, those names are added as parameters on `finish`, typed to their declared type — `string` by default, or `number`/`boolean`/`object`/`array` when declared non-string. The `finish` schema validates the emitted value against the declared type, and the engine stores it with that type under the result's `outputs`. Downstream steps read them via `${{result.STEP_ID.outputName}}`.

**Post-finish blocking:** Once `finish` is called, the guard blocks any further tool calls. The engine extracts the result from the `finish` call parameters.

---

## Tool Availability Matrix

| Tool | Main session LLM | Flow agent | External package agent |
|------|:---:|:---:|:---:|
| `ask_user` | ✓ | ✓ (blocked in autonomous) | ✓ |
| `subagent` | ✓ | — | — |
| `flow_agents` | ✓ (inactive unless `flows.editFlow`) | — | — |
| `flow_write` | ✓ (inactive unless `flows.editFlow`) | — | — |
| `finish` | — | ✓ | ✓ |
| `read/write/edit/grep/…` | ✓ (always) | declared in frontmatter | declared in frontmatter |
| Custom (via `flow:register-tool`) | — | ✓ | ✓ |

Standard file-system tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) are granted to agents based on the `tools:` field in their `.md` frontmatter. The guard extension enforces that agents only call tools they declared.
