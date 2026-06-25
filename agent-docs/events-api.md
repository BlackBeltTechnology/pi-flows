# Events API Reference

pi-flows communicates with extensions through typed event bus on `pi.events`. Every interaction — registering content, observing running flow, querying state — mediated by named `flow:*` events.

---

## How the event bus works

```typescript
// Listen (subscribe)
const unsub = pi.events.on("flow:complete", (data: FlowResult) => { ... });
unsub(); // unsubscribe

// Emit (fire-and-forget)
pi.events.emit("flow:notify", { message: "Done!", level: "info" });

// Query pattern (synchronous mutation of the data object)
const query = { agents: undefined as any };
pi.events.emit("flow:get-agents", query);
const agents: Map<string, AgentConfig> = query.agents;
```

**Query pattern** (mutation of data object) used when caller needs immediate synchronous answer from pi-flows. Listener mutates payload object in-place and returns.

---

## Category 1 — Registration (extension → pi-flows)

Emit during extension's `activate()` to register content with pi-flows.

### `flow:register-agents-dir`

Register directory of agent `.md` files. Triggers immediate re-discovery scan.

```typescript
pi.events.emit("flow:register-agents-dir", { dir: "/abs/path/to/agents" });
```

**Payload:**
```typescript
{ dir: string }  // Absolute path to directory containing *.md agent files
```

Re-discovery overwrites agents with same `name` — later registrations win.

---

### `flow:unregister-agents-dir`

Unregister previously registered agents directory.

```typescript
pi.events.emit("flow:unregister-agents-dir", { dir: "/abs/path/to/agents" });
```

**Payload:** `{ dir: string }`

---

### `flow:register-flows-dir`

Register directory of flow `.yaml` files. Triggers re-discovery and registers new flows as slash-commands.

```typescript
pi.events.emit("flow:register-flows-dir", { dir: "/abs/path/to/flows" });
```

**Payload:** `{ dir: string }`

Flow names derived from filesystem path relative to registered root:
- `flows/research.yaml` → `research`
- `flows/judo/research.yaml` → `judo:research`

Maximum nesting depth: one subfolder. Files nested two or more levels deep skipped with warning.

---

### `flow:unregister-flows-dir`

Unregister previously registered flows directory.

```typescript
pi.events.emit("flow:unregister-flows-dir", { dir: "/abs/path/to/flows" });
```

**Payload:** `{ dir: string }`

---

### `flow:register-skills-dir`

Register directory of skill bundles. Each subdirectory must contain `SKILL.md` index file.

```typescript
pi.events.emit("flow:register-skills-dir", { dir: "/abs/path/to/skills" });
```

**Payload:** `{ dir: string }`

Skills registered here searchable via `skill_read` tool. See [flow-authoring.md](flow-authoring.md) for skill directory format.

---

### `flow:register-agent-extension`

Inject extension into every spawned agent subprocess. Use to add guards, provider middleware, or custom tools to all subagent sessions.

```typescript
// Option A: factory function (in-process, preferred)
pi.events.emit("flow:register-agent-extension", {
  factory: async (piApi: ExtensionAPI) => {
    piApi.on("tool_call", (event: any) => {
      if (event.toolName === "bash" && event.params?.command?.startsWith("rm -rf")) {
        return { block: true, reason: "rm -rf not allowed" };
      }
    });
  },
});

// Option B: path to a TypeScript/JS file (loaded via dynamic import)
pi.events.emit("flow:register-agent-extension", {
  path: join(pkgRoot, "extensions", "my-guard.ts"),
});
```

**Payload:**
```typescript
{
  factory?: (pi: ExtensionAPI) => void | Promise<void>;  // in-process factory
  path?: string;   // path to an extension module file
}
```

Exactly one of `factory` or `path` must be set. Factories preferred for performance (no module load overhead). Extensions registered here run in every spawned agent session — keep lightweight.

> **Note:** `flow:register-guard-extension` is deprecated alias; prefer `flow:register-agent-extension`.

---

### `flow:register-gate`

Register precondition gate that blocks named flows from running unless condition satisfied.

```typescript
pi.events.emit("flow:register-gate", {
  name:    "auth-required",
  check:   () => isAuthenticated(),
  flows:   ["judo:*"],           // supports trailing wildcard
  message: "You must be logged in. Run /login first.",
});
```

**Payload:**
```typescript
{
  name:    string;            // unique gate identifier
  check:   () => boolean;     // returns true if the gate PASSES (flow may run)
  flows:   string[];          // flow names or patterns (trailing * wildcard)
  message: string;            // shown to user when gate blocks the flow
}
```

Gates checked synchronously before any flow step runs.

---

### `flow:register-tool`

Make custom tool available inside spawned agent sessions (not main session). Extension-provided tools appear alongside built-in tools in subagent sessions.

```typescript
import { Type } from "@sinclair/typebox";

pi.events.emit("flow:register-tool", {
  tool: {
    name: "my_domain_query",
    description: "Query domain-specific data.",
    parameters: Type.Object({
      entityId: Type.String({ description: "Entity to query" }),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      const result = await queryDomain(params.entityId);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  },
});
```

**Payload:**
```typescript
{ tool: ToolDefinition }  // Full tool object including .execute()
```

`ToolDefinition` follows same shape as `pi.registerTool()` — see pi-coding-agent SDK docs.

---

### `flow:register-card`

Register custom metric renderer for agent dashboard. Called with `name` mapping to `card.metric` field in agent frontmatter.

```typescript
pi.events.emit("flow:register-card", {
  name:    "my-metric",
  factory: () => new MyMetricRenderer(),
});
```

**Payload:**
```typescript
{
  name:    string;             // matches agent frontmatter: card.metric: "my-metric"
  factory: () => AgentCardRenderer;
}
```

`AgentCardRenderer` interface:
```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;  // single metric line shown in the card
}
```

---

### `flow:register-workflow`

Register workflow pipeline definition used by dashboard breadcrumb to show progress stages.

```typescript
pi.events.emit("flow:register-workflow", {
  id: "my-pipeline",
  stages: [
    { name: "Research", flows: ["my-pipeline:research"] },
    { name: "Implement", flows: ["my-pipeline:implement"] },
    { name: "Verify",    flows: ["my-pipeline:verify"] },
  ],
});
```

**Payload:**
```typescript
{
  id:     string;            // unique workflow identifier
  stages: WorkflowStage[];
}

interface WorkflowStage {
  name:      string;         // display name in breadcrumb
  flows:     string[];       // flow/command names that map to this stage
  detailFn?: (ctx: any) => string;  // optional dynamic detail text
}
```

---

### `flow:register-footer-segment`

Add custom segment to TUI footer bar.

```typescript
pi.events.emit("flow:register-footer-segment", {
  id:       "my-segment",
  priority: 10,              // higher = further right
  render:   () => "◉ connected",
});
```

**Payload:**
```typescript
{
  id:       string;
  priority: number;
  render:   () => string;    // returns styled text for the footer
}
```

---

## Category 2 — Runtime (pi-flows → extension)

Listen to observe running flow.

### `flow:flow-started`

Emitted when flow begins execution.

```typescript
pi.events.on("flow:flow-started", (data: {
  flowName: string;
  flow: FlowConfig;
  task: string;
}) => { ... });
```

---

### `flow:agent-started`

Emitted when individual agent step begins.

```typescript
pi.events.on("flow:agent-started", (data: {
  agentName:     string;
  stepId:        string;
  resolvedModel: string;   // actual model ID after role resolution
}) => { ... });
```

---

### `flow:agent-complete`

Emitted when agent step finishes (success or error).

```typescript
pi.events.on("flow:agent-complete", (data: {
  agentName: string;
  stepId:    string;
  result:    AgentResult;
}) => { ... });
```

---

### `flow:assistant-text`

Streaming assistant text chunk from running agent.

```typescript
pi.events.on("flow:assistant-text", (data: {
  agentName: string;
  stepId:    string;
  text:      string;
}) => { ... });
```

---

### `flow:thinking-text`

Streaming thinking/reasoning text chunk from running agent.

```typescript
pi.events.on("flow:thinking-text", (data: {
  agentName: string;
  stepId:    string;
  text:      string;
}) => { ... });
```

---

### `flow:subagent-tool-call`

Agent called tool.

```typescript
pi.events.on("flow:subagent-tool-call", (data: {
  agentName: string;
  stepId:    string;
  toolName:  string;
  input:     any;
}) => { ... });
```

---

### `flow:subagent-tool-result`

Tool call returned result.

```typescript
pi.events.on("flow:subagent-tool-result", (data: {
  agentName: string;
  stepId:    string;
  toolName:  string;
  output:    any;
  isError:   boolean;
}) => { ... });
```

---

### `flow:auto-decision`

Agent made autonomous decision at fork step (autonomous mode).

```typescript
pi.events.on("flow:auto-decision", (data: {
  forkId:       string;
  agentName:    string;
  chosenBranch: string;
  targetStepId: string;
}) => { ... });
```

---

### `flow:loop-iteration`

Loop decision step started new iteration.

```typescript
pi.events.on("flow:loop-iteration", (data: {
  stepId:        string;
  iteration:     number;
  maxIterations: number;
  loopTarget?:   string;  // step jumped back to
}) => { ... });
```

---

### `flow:complete`

Emitted when flow finishes (success, error, or abort).

```typescript
pi.events.on("flow:complete", (data: FlowResult) => {
  console.log(`Flow "${data.flowName}" completed in ${data.totalDuration}ms`);
  console.log(`Steps: ${data.stepCount}`);
});
```

`FlowResult` shape — see [public-api.md](public-api.md#flowresult).

---

### `flow:notify`

General notification from pi-flows to display to user.

```typescript
pi.events.on("flow:notify", (data: {
  message: string;
  level:   "info" | "warning" | "error";
}) => { ... });
```

---

### `flow:autonomous-mode-changed`

Autonomous mode toggled.

```typescript
pi.events.on("flow:autonomous-mode-changed", (data: {
  enabled: boolean;
}) => { ... });
```

---

### `flow:summary-ready`

Flow summary ready to display in TUI.

```typescript
pi.events.on("flow:summary-ready", (data: {
  flowResult: FlowResult;
  agentNames: string[];
}) => { ... });
```

---

### `flow:summary-dismissed`

User dismissed post-flow summary overlay.

```typescript
pi.events.on("flow:summary-dismissed", () => { ... });
```

---

## Category 3 — Architect Lifecycle (pi-flows → extension)

Architect: AI-powered flow designer. Events track its lifecycle.

| Event | Direction | Payload |
|-------|-----------|---------|
| `flow:architect-started` | emit | `{ flowName, mode: "new"\|"edit" }` |
| `flow:architect-tool-call` | emit | `{ toolName, input }` |
| `flow:architect-tool-result` | emit | `{ toolName, output, isError }` |
| `flow:architect-text` | emit | `{ kind: "assistant"\|"thinking", text }` |
| `flow:architect-context-generating` | emit | `{ mode: "new"\|"edit" }` |
| `flow:architect-context-ready` | emit | `{ hasContext: boolean }` |
| `flow:architect-preview` | emit | `{ flows, parsedFlows, flowPath, createdFiles }` |
| `flow:architect-replan` | emit | `{ iteration: number, notes: string }` |
| `flow:architect-saved` | emit | `{ flowName, flowPath }` |
| `flow:architect-complete` | emit | `{ choice: "save"\|"cancel"\|"error", flowName?, flowPath? }` |
| `flow:architect-cancelled` | emit | `{ phase: string }` |
| `flow:architect-error` | emit | `{ error?\|summary }` |
| `flow:architect-init-error` | emit | `{ reason: "no-flows"\|"agent-not-found" }` |
| `flow:architect-run-handoff` | emit | `{ flowName }` — auto-run after save |
| `flow:architect-abort` | listen | `{}` — send to cancel an in-progress architect run |

---

## Category 4 — Query/Control

Two-way synchronous query events and programmatic control signals.

### `flow:run`

Programmatically trigger flow by name.

```typescript
pi.events.emit("flow:run", { flowName: "my-flow" });
```

**Payload:** `{ flowName: string }`

Ignored if flow already running.

---

### `flow:abort`

Abort currently running flow.

```typescript
pi.events.emit("flow:abort", {});
```

---

### `flow:toggle-autonomous`

Toggle autonomous mode on or off. Fires `flow:autonomous-mode-changed` after toggling.

```typescript
pi.events.emit("flow:toggle-autonomous", {});
```

---

### `flow:set-edit-mode`

Toggle authoring edit-mode. Inbound: dashboard -> pi-flows. Same handler as `/flows:edit-mode <on|off>` command.

```typescript
pi.events.emit("flow:set-edit-mode", { enabled: true });
```

**Payload:** `{ enabled: boolean }`

Handler writes `flows.editFlow` to project `.pi/settings.json` (read-merge-write, preserves other keys, never global file). Syncs project-local skill `.pi/skills/edit-flow/SKILL.md`, frontmatter `disable-model-invocation` = `!enabled`. Reconciles `flow_agents`/`flow_write` tools.
Event path runs base `ExtensionContext`. No reload. Tools update immediately. Skill visibility next session start.
Command `/flows:edit-mode` path adds `ctx.reload()`. Change fully live current session.

---

### `flow:rediscover`

Force full re-discovery of agents and flows from all registered directories.

```typescript
pi.events.emit("flow:rediscover", {});
```

Called automatically by `flow_write` and `flow_agents` (op `write`) after writing files.

---

### `flow:get-agents` (query)

Retrieve current agent map synchronously.

```typescript
const q = {} as { agents: Map<string, AgentConfig> };
pi.events.emit("flow:get-agents", q);
const agents = q.agents;
```

---

### `flow:list-flows` (query)

List all discovered flows as plain array.

```typescript
const q = {} as { flows: FlowListEntry[] };
pi.events.emit("flow:list-flows", q);

interface FlowListEntry {
  name:         string;
  description:  string;
  source:       string;
  taskRequired: boolean;
}
```

---

### `flow:get-session-entries` (query)

Get current session's conversation entries.

```typescript
const q = {} as { entries: any[] };
pi.events.emit("flow:get-session-entries", q);
```

---

### `flow:get-spawn-context` (query)

Get context needed to spawn agent sessions programmatically.

```typescript
const q = {} as {
  authStorage:          any;
  modelRegistry:        any;
  extraAgentExtensions: any[];
  extensionTools:       any[];
};
pi.events.emit("flow:get-spawn-context", q);
```

---

### `flow:delete-request` / `flow:delete-result`

Request deletion of project-local flow file.

```typescript
// Request
pi.events.emit("flow:delete-request", { flowName: "my-flow" });

// Listen for result
pi.events.on("flow:delete-result", (data: {
  success:   boolean;
  flowName:  string;
  error?:    string;
}) => { ... });
```

---

### `flow:prompt-request` / `flow:prompt-response`

Low-level prompt bus used internally. Prefer `ctx.ui.*` methods or `ask_user` tool.

```typescript
// Emit a prompt
pi.events.emit("flow:prompt-request", {
  pipeline: "my-pipeline",
  type:     "input",     // "input" | "select" | "confirm"
  question: "Enter value:",
});

// Listen for the response
pi.events.on("flow:prompt-response", (data: {
  answer:     string;
  cancelled?: boolean;
}) => { ... });
```

---

## Category 5 — Role Management

Events for configuring model roles (`@planning`, `@coding`, etc.).

| Event | Direction | Payload |
|-------|-----------|---------|
| `flow:role-get-all` | query | `{ roles: Map<string, string> }` — mutated with current roles |
| `flow:role-set` | emit | `{ role: string, modelId: string }` |
| `flow:role-preset-load` | emit | `{ name: string }` |
| `flow:role-preset-save` | emit | `{ name: string }` |
| `flow:role-preset-delete` | emit | `{ name: string }` |
| `flow:roles-manage-request` | emit | `{}` — opens the roles management UI |
| `flow:get-available-models` | query | `{ models: string[] }` — mutated with authenticated models |
