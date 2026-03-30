# Events API

All `flow:*` events that pi-flows emits and listens to. This is the primary extension surface for packages that depend on pi-flows. Events are dispatched via `pi.events` from within your extension's `activate` function.

---

## Overview

Events are categorized by direction:

| Category | Description |
|----------|-------------|
| [Registration](#registration-events) | You emit → pi-flows handles. Register agents, flows, cards, tools, etc. |
| [Runtime](#runtime-events) | pi-flows emits → you listen. React to flow execution lifecycle. |
| [Internal / Query](#internal--query-events) | Used between pi-flows sub-extensions. Avoid from external packages. |

All events are **fire-and-forget** (they do not return a value) except the query events, which mutate a shared object passed as event data.

---

## Registration Events

Emit these events from your extension's `activate` function to register content with pi-flows. Registration is synchronous — pi-flows processes each event immediately on receipt.

> **Timing:** Emit registration events at the top of `activate`, before any `await`. pi-flows reads them during the same synchronous turn.

### `flow:register-agents-dir`

Add a directory of agent `.md` files to the agent discovery pool.

```typescript
pi.events?.emit("flow:register-agents-dir", { dir: string });
```

**Data shape:**

```typescript
{ dir: string }  // Absolute path to agents directory
```

**Behavior:** pi-flows scans the directory for `*.md` files (excluding `*.yaml`), parses each as an `AgentConfig`, and adds them to the agent registry. If an agent with the same name already exists, the new one overwrites it. Re-discovery runs immediately.

**Example:**

```typescript
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
```

---

### `flow:register-flows-dir`

Add a directory of `.yaml` files. Each discovered flow is registered as a slash command.

```typescript
pi.events?.emit("flow:register-flows-dir", { dir: string });
```

**Data shape:**

```typescript
{ dir: string }  // Absolute path to flows directory
```

**Behavior:** pi-flows recursively scans the directory for `*.yaml` files. The slash command name is derived from the file path relative to the flows directory root:

| File path | Registered command |
|-----------|-------------------|
| `flows/research.yaml` | `/research` |
| `flows/my-domain/research.yaml` | `/my-domain:research` |

Nesting deeper than one subfolder is skipped with a warning. Later registrations with the same flow name win (project-local files have the highest priority).

**Example:**

```typescript
pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
```

---

### `flow:unregister-agents-dir`

Remove a previously registered agents directory.

```typescript
pi.events?.emit("flow:unregister-agents-dir", { dir: string });
```

Used for cleanup after temporary staging directories (e.g., when the flow workspace saves a new agent). Triggers re-discovery.

---

### `flow:unregister-flows-dir`

Remove a previously registered flows directory.

```typescript
pi.events?.emit("flow:unregister-flows-dir", { dir: string });
```

The flows that were registered from this directory are no longer discoverable, but their slash commands persist until the session ends (commands cannot be unregistered at runtime).

---

### `flow:register-skills-dir`

Add a skills directory so its skills become available to agents that declare them.

```typescript
pi.events?.emit("flow:register-skills-dir", { dir: string });
```

**Data shape:**

```typescript
{ dir: string }  // Absolute path to skills directory
```

**Behavior:** Skills are directories inside the skills root, each containing a `SKILL.md` file. When an agent declares a skill by name (in its frontmatter `skills:` field), pi-flows searches registered skills directories in registration order, falling back to pi-flows' own built-in skills. Package skills take precedence over built-in skills; project-local skills (`.pi/skills/`) have the highest priority.

**Example:**

```typescript
pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });
```

---

### `flow:register-card`

Register a custom dashboard card metric renderer for a named card type.

```typescript
pi.events?.emit("flow:register-card", {
  name: string;
  factory: () => AgentCardRenderer;
});
```

**Data shape:**

```typescript
{
  name: string;                      // Metric type name (matches agent's card.metric field)
  factory: () => AgentCardRenderer;  // Factory that creates a new renderer instance per agent
}
```

`AgentCardRenderer` interface (from `flow-dashboard/types.ts`):

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;  // Returns a single metric line
}
```

**Behavior:** A fresh renderer instance is created for each agent card via `factory()`. The renderer receives tool call/result events as the agent runs, and `renderMetric` is called on each dashboard frame to produce the metric line shown below the agent name.

**Example — custom model card:**

```typescript
// cards/model-card.ts
import type { AgentCardRenderer } from "pi-flows/extensions/flow-dashboard/types.js";

export class ModelCard implements AgentCardRenderer {
  private queries = 0;
  private mutations = 0;

  onToolCall(toolName: string, input: any): void {
    if (toolName !== "model_cli") return;
    if (input?.query?.startsWith("mutation")) this.mutations++;
    else this.queries++;
  }

  onToolResult(): void {}
  onComplete(): void {}

  renderMetric(width: number): string {
    return `  query:${this.queries} │ mut:${this.mutations}`.slice(0, width);
  }
}

// In activate():
pi.events?.emit("flow:register-card", {
  name: "model",
  factory: () => new ModelCard(),
});
```

Agents reference the card type in their frontmatter:

```yaml
card:
  label: "Model"
  metric: "model"   # ← matches the registered name
```

Built-in metric names: `default`, `files`, `tests`.

---

### `flow:register-workflow`

Register a multi-stage workflow pipeline. When a flow belonging to a workflow runs, the dashboard displays a breadcrumb showing all stages and which one is active.

```typescript
pi.events?.emit("flow:register-workflow", WorkflowDefinition);
```

**Data shape:**

```typescript
interface WorkflowDefinition {
  id: string;              // Unique workflow ID (e.g., "sdd")
  stages: WorkflowStage[]; // Ordered pipeline stages
}

interface WorkflowStage {
  name: string;           // Display name shown in breadcrumb
  flows: string[];        // Flow/command names that trigger this stage
  detailFn?: (ctx: any) => string;  // Optional: dynamic detail text
}
```

**Example:**

```typescript
pi.events?.emit("flow:register-workflow", {
  id: "my-pipeline",
  stages: [
    { name: "research", flows: ["my-domain:research"] },
    { name: "apply",    flows: ["my-domain:apply"] },
    { name: "verify",   flows: ["my-domain:verify"] },
  ],
});
```

When `/my-domain:apply` runs, the breadcrumb shows:
```
research-all → [apply] → verify
```

Multiple `flow:register-workflow` events can be emitted for independent workflows.

---

### `flow:register-gate`

Register a prerequisite check that must pass before specific flows can run. If the check fails, the user sees the error message and the flow is blocked.

```typescript
pi.events?.emit("flow:register-gate", {
  name: string;
  check: () => boolean;
  flows: string[];
  message: string;
});
```

**Data shape:**

```typescript
{
  name: string;         // Unique gate identifier (for debugging)
  check: () => boolean; // Returns true if the gate passes
  flows: string[];      // Flow name patterns this gate applies to (supports trailing "*")
  message: string;      // Error shown to the user when the gate fails
}
```

**Flow name patterns:**

| Pattern | Matches |
|---------|---------|
| `"my-domain:*"` | All flows starting with `my-domain:` |
| `"my-domain:research"` | Exactly `/my-domain:research` |

**Example — project gate:**

```typescript
import { globSync } from "node:fs";
import { join } from "node:path";

const projectReady = globSync(join(cwd, "config", "*.config")).length > 0;

pi.events?.emit("flow:register-gate", {
  name: "my-domain-project",
  check: () => projectReady,
  flows: ["my-domain:*"],
  message: "No config files found. Domain flows require a configured project.",
});
```

---

### `flow:register-guard-extension`

Register an additional sandboxing guard that is loaded into every spawned agent subprocess. Guards intercept tool calls to enforce access policies.

```typescript
pi.events?.emit("flow:register-guard-extension", {
  factory: (pi: ExtensionAPI) => void;
});
```

**Data shape:**

```typescript
{
  factory: (pi: ExtensionAPI) => void;  // Extension factory loaded in each agent session
}
```

**Behavior:** The factory is called once per spawned agent session. It receives a scoped `ExtensionAPI` for that session. Typically registers a `tool_call` listener to intercept and optionally block tool execution.

**Example — protected file guard:**

```typescript
// guards.ts
export function createProtectionGuard() {
  return (event: any, ctx: any, next: () => void) => {
    if (event.name === "write" && event.params.path?.endsWith(".config")) {
      ctx.block("Direct .config file modification is forbidden. Use the domain_cli tool.");
      return;
    }
    next();
  };
}

// In activate():
pi.events?.emit("flow:register-guard-extension", {
  factory: (piApi: ExtensionAPI) => {
    piApi.on("tool_call", createProtectionGuard());
  },
});
```

---

### `flow:register-footer-segment`

Add a custom segment to the status bar footer. Segments are rendered after pi-flows' built-in segments (provider, git branch, file stats, context usage).

```typescript
pi.events?.emit("flow:register-footer-segment", {
  name: string;
  render: () => string | null;
  onRegistered?: (invalidate: () => void) => void;
});
```

**Data shape:**

```typescript
{
  name: string;                               // Unique segment name (re-registration replaces previous)
  render: () => string | null;                // Returns segment text, or null to hide
  onRegistered?: (invalidate: () => void) => void;  // Callback with a function to trigger re-render
}
```

**Behavior:** Segments are rendered in registration order. If `render()` returns `null`, the segment is omitted. Segments are separated by ` │ ` in the footer.

**Example — server status segment:**

```typescript
let invalidateFn: (() => void) | null = null;

pi.events?.emit("flow:register-footer-segment", {
  name: "domain-server",
  render: () => {
    const state = serverManager.getState();
    if (state === "running") return "● server";
    if (state === "starting") return "◐ server";
    if (state === "error")    return "✗ server";
    return "○ server";
  },
  onRegistered: (invalidate) => { invalidateFn = invalidate; },
});

// Later, when server state changes:
serverManager.onStateChange(() => invalidateFn?.());
```

pi-flows itself registers the `autonomous-mode` segment:

```typescript
pi.events?.emit("flow:register-footer-segment", {
  name: "autonomous-mode",
  render: () => isAutonomousMode() ? "AUTO" : null,
});
```

---

### `flow:register-tool`

> **Deprecated.** Tools registered via `pi.registerTool()` are now automatically discovered by the flow engine and available to subagent sessions. This event still works for backward compatibility but is no longer needed in new packages. Just use `pi.registerTool()` instead.

Register a custom tool for use by agents in flow sessions.

**Usage** — `pi.registerTool()` is now sufficient (no event needed):

```typescript
const myTool = {
  name: "my_tool",
  description: "My custom tool",
  parameters: Type.Object({ /* ... */ }),
  execute: async (_id, params, _signal, _onUpdate, _ctx) => { /* ... */ },
};
pi.registerTool(myTool);
// pi.events.emit("flow:register-tool", { tool: myTool }); // no longer needed
```

**Data shape:**

```typescript
{
  tool: ToolDefinition;  // Standard pi-coding-agent tool definition object
}
```

A `ToolDefinition` has the same shape as tools registered via `pi.registerTool()`:

```typescript
{
  name: string;
  description: string;
  parameters: TSchema;           // TypeBox schema
  execute: (toolCallId, params, signal, onUpdate, ctx) => Promise<ToolResult>;
}
```

**Behavior:** Registered tools are injected into every spawned agent session (`spawnAgent` call) as `extraCustomTools`. Only agents that explicitly list the tool name in their frontmatter `tools:` field can call it.

**Example:**

```typescript
import { Type } from "@sinclair/typebox";

const myTool = {
  name: "model_cli",
  description: "Query or mutate the domain model via GraphQL.",
  parameters: Type.Object({
    command: Type.Union([Type.Literal("query"), Type.Literal("save")]),
    query: Type.Optional(Type.String()),
  }),
  execute: async (_id, params, _signal, _onUpdate, _ctx) => {
    // ... implementation
    return { content: [{ type: "text", text: "result" }], details: {} };
  },
};

pi.events?.emit("flow:register-tool", { tool: myTool });
```

Agents declare it in frontmatter:

```yaml
tools: read, write, model_cli
```

---

## Runtime Events

Listen to these events to react to flow execution lifecycle. Use `pi.events?.on(...)` from within `activate`.

### `flow:complete`

Fired when a flow finishes — whether successfully, with an error, or aborted by the user. Always fires exactly once per flow run.

```typescript
pi.events?.on("flow:complete", (data: FlowResult) => { ... });
```

**Data shape (`FlowResult`):**

```typescript
interface FlowResult {
  flowName: string;      // The flow that ran (e.g., "my-domain:apply")
  status?: "success" | "error" | "aborted";
  stepCount: number;     // Number of steps that ran
  totalDuration: number; // Wall-clock time in milliseconds

  // Per-step result summaries (keyed by step ID)
  results: Record<string, {
    fullOutput: string;  // Raw agent output text
    status: string;      // "complete" | "error" | "blocked"
    summary: string;     // From the agent's finish() call
    artifacts: string;   // Raw XML from <artifacts> block
    files: string;       // Human-readable file list (e.g., "src/auth.ts (created)")
  }>;

  // Fork answers (keyed by fork step ID)
  forks: Record<string, { answer: string; notes?: string }>;

  // The result from the final step that ran
  lastResult: AgentResult;
}
```

**Example:**

```typescript
pi.events?.on("flow:complete", (data: unknown) => {
  const result = data as FlowResult;
  if (result.status === "success") {
    console.log(`Flow "${result.flowName}" completed in ${result.totalDuration}ms`);
    const researchSummary = result.results["researcher"]?.summary;
    if (researchSummary) {
      // Post-process or store result
    }
  }
});
```

---

### `flow:subagent-tool-call`

Fired each time a running agent calls a tool. Use to observe agent behavior or collect metrics.

```typescript
pi.events?.on("flow:subagent-tool-call", (data) => { ... });
```

**Data shape:**

```typescript
{
  agentName: string;  // Name of the agent making the call (e.g., "researcher")
  toolName: string;   // Tool being called (e.g., "bash", "model_cli")
  input: any;         // Tool input parameters
}
```

**Example:**

```typescript
pi.events?.on("flow:subagent-tool-call", (data: any) => {
  if (data.toolName === "model_cli") {
    trackMutation(data.agentName, data.input);
  }
});
```

---

### `flow:subagent-tool-result`

Fired each time a tool returns a result to the running agent.

```typescript
pi.events?.on("flow:subagent-tool-result", (data) => { ... });
```

**Data shape:**

```typescript
{
  agentName: string;  // Agent that received the result
  toolName: string;   // Tool that returned
  output: any;        // Tool output
  isError?: boolean;  // true if the tool call failed
}
```

---

### `flow:auto-decision`

Fired when a fork step automatically selects a branch in autonomous mode (Ctrl+A is active and the fork has an `agent:` field).

```typescript
pi.events?.on("flow:auto-decision", (data) => { ... });
```

**Data shape:**

```typescript
{
  forkId: string;        // ID of the fork step that auto-decided
  agentName: string;     // Agent that made the decision
  chosenBranch: string;  // The selected option text
  targetStepId: string;  // The step ID the flow will continue to
}
```

---

### `flow:loop-iteration`

Fired each time an `agent-loop-decision` step advances to the next iteration.

```typescript
pi.events?.on("flow:loop-iteration", (data) => { ... });
```

**Data shape:**

```typescript
{
  stepId: string;      // ID of the loop decision step
  iteration: number;   // Current iteration (1-based)
  maxIterations: number; // Maximum configured iterations
}
```

---

## Internal / Query Events

These events coordinate between pi-flows' own sub-extensions. **Do not emit or listen to these from external packages** — they are implementation details and may change without notice.

| Event | Direction | Purpose |
|-------|-----------|---------|
| `flow:run` | emit → pi-flows | Programmatically run a named flow with an optional UI context |
| `flow:rediscover` | emit → pi-flows | Trigger re-scanning of agent and flow directories |
| `flow:get-agents` | emit with data object → pi-flows mutates | Query the current agent registry |
| `flow:get-flows` | emit with data object → pi-flows mutates | Query the current flow registry |
| `flow:get-spawn-context` | emit with data object → pi-flows mutates | Query spawn context (auth, model registry, extension tools) for subagent sessions |
| `flow:wire-dashboard` | internal | Mount a dashboard widget |
| `flow:unwire-dashboard` | internal | Unmount a dashboard widget |
| `flow:set-summary-context` | internal | Pass tool history to summary widget |
| `flow:set-summary-tool-history` | internal | Pass tool history per-agent to summary widget |
