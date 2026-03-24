# Events API

pi-flows uses `pi.events` (the shared event bus from pi's extension API) for all inter-extension communication. Dependent packages register resources, listen for runtime events, and query discovery state through these events.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    pi-flows Event Architecture                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─── Registration (you → pi-flows) ──┐  ┌── Runtime (pi-flows → you) ──┐
│  │                                     │  │                              │
│  │  flow:register-agents-dir           │  │  flow:run                    │
│  │  flow:register-flows-dir            │  │  flow:complete               │
│  │  flow:register-skills-dir           │  │  flow:rediscover             │
│  │  flow:register-card                 │  │  flow:subagent-tool-call     │
│  │  flow:register-workflow             │  │  flow:subagent-tool-result   │
│  │  flow:register-gate                 │  │  flow:loop-iteration         │
│  │  flow:register-guard-extension      │  │                              │
│  │  flow:register-footer-segment       │  │                              │
│  │                                     │  └──────────────────────────────┘
│  └─────────────────────────────────────┘                             │
│                                                                     │
│  ┌─── Query (synchronous read-back) ──┐                             │
│  │                                     │                             │
│  │  flow:get-agents                    │                             │
│  │  flow:get-flows                     │                             │
│  │                                     │                             │
│  └─────────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Table of Contents

- [Registration Events](#registration-events)
- [Runtime Events](#runtime-events)
- [Query Events](#query-events)
- [Key Type Shapes](#key-type-shapes)

---

## Registration Events

Registration events are emitted by your extension to extend pi-flows. Emit them in your `activate(pi)` function during extension load. pi-flows listens for these and integrates your resources into the flow engine, dashboard, and footer.

### flow:register-agents-dir

Register a directory of agent `.md` files for discovery.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ dir: string }` |
| **Effect** | Agents in the directory are discovered and become available in flows. Triggers re-discovery. |

```typescript
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pkgRoot = join(dirname(__filename), "..", "..");

pi.events?.emit("flow:register-agents-dir", {
  dir: join(pkgRoot, "agents"),
});
```

### flow:register-flows-dir

Register a directory of `.flow.md` files for discovery. Newly discovered flows are auto-registered as `/commands`.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ dir: string }` |
| **Effect** | Flows in the directory are discovered. New flows register as slash commands (e.g., `/my-flow`). |

```typescript
pi.events?.emit("flow:register-flows-dir", {
  dir: join(pkgRoot, "flows"),
});
```

### flow:register-skills-dir

Register a directory of skill files for agent prompt injection.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ dir: string }` |
| **Effect** | Skills in the directory become available to agents via the `skills:` frontmatter field and the `skill_read` tool. |

```typescript
pi.events?.emit("flow:register-skills-dir", {
  dir: join(pkgRoot, "skills"),
});
```

### flow:register-card

Register a custom dashboard card metric renderer. Cards display agent-specific metrics (file counts, test results, domain-specific data) on the live dashboard during flow execution.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ name: string, factory: () => AgentCardRenderer }` |
| **Effect** | Agents with `card.metric: "<name>"` in their frontmatter use this renderer. |

```typescript
import { MyCustomCard } from "./cards/my-card.js";

pi.events?.emit("flow:register-card", {
  name: "my-metric",
  factory: () => new MyCustomCard(),
});
```

The `AgentCardRenderer` interface:

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;  // Single metric line for the card
}
```

See [extending-pi-flows.md](extending-pi-flows.md#custom-card-renderers) for a full implementation guide.

### flow:register-workflow

Register a multi-stage workflow definition. Workflows appear as breadcrumb navigation in the dashboard, showing which stage of a pipeline is currently active.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `WorkflowDefinition` (see below) |
| **Effect** | When a flow matching a stage's `flows` array runs, the breadcrumb shows the workflow pipeline. |

```typescript
pi.events?.emit("flow:register-workflow", {
  id: "my-pipeline",
  stages: [
    { name: "research", flows: ["my-pkg:research"] },
    { name: "implement", flows: ["my-pkg:implement"] },
    { name: "verify", flows: ["my-pkg:verify"] },
  ],
});
```

The `WorkflowDefinition` type:

```typescript
interface WorkflowDefinition {
  id: string;
  stages: WorkflowStage[];
}

interface WorkflowStage {
  name: string;          // Display name (e.g., "research", "implement")
  flows: string[];       // Flow names that trigger this stage
  detailFn?: (ctx: any) => string;  // Dynamic detail text (e.g., "wave 2/4")
}
```

### flow:register-gate

Register a prerequisite check that must pass before specific flows can run. If the check fails, the flow is blocked with a user-facing message.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `GateEntry` (see below) |
| **Effect** | Before any matching flow runs, `check()` is called. If it returns `false`, the flow is blocked. |

```typescript
pi.events?.emit("flow:register-gate", {
  name: "project-check",
  check: () => existsSync(join(cwd, "model")),
  flows: ["my-pkg:*"],          // Glob pattern matching flow names
  message: "No project found. Run from a project root.",
});
```

The `GateEntry` type:

```typescript
interface GateEntry {
  name: string;            // Unique gate identifier
  check: () => boolean;    // Returns true if the gate passes
  flows: string[];         // Glob patterns for flow names this gate applies to
  message: string;         // User-facing message when gate fails
}
```

**Glob matching:** Patterns ending with `*` match any flow name starting with the prefix (e.g., `"my-pkg:*"` matches `"my-pkg:build"`, `"my-pkg:test"`). Exact strings match only that flow name.

### flow:register-guard-extension

Register an additional guard extension that is loaded into spawned subagent processes. Use this to add file access guards, custom tool restrictions, or other sandboxing rules for agents dispatched by the flow engine.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ path: string }` |
| **Effect** | The extension file at `path` is loaded via `--extension` in every spawned subagent process, alongside pi-flows' built-in guard. |

```typescript
pi.events?.emit("flow:register-guard-extension", {
  path: join(__dirname, "my-subagent-guard.ts"),
});
```

The extension file must be a valid pi extension with a default export:

```typescript
// my-subagent-guard.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", (event: any) => {
    // Block access to .secret files
    const params = event.params || event.input || {};
    if ((params.file_path || "").endsWith(".secret")) {
      return { block: true, reason: "Direct .secret file access is blocked." };
    }
    return undefined;
  });
}
```

### flow:register-footer-segment

Register a custom segment in the footer bar. The footer displays status information below the editor.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ name: string, render: () => string, onRegistered?: (invalidate: () => void) => void }` |
| **Effect** | A new segment appears in the footer bar. Call `invalidate()` to trigger re-renders when your data changes. |

```typescript
let invalidateFn: (() => void) | null = null;

pi.events?.emit("flow:register-footer-segment", {
  name: "my-status",
  render: () => {
    const count = getItemCount();
    return `${count} items`;
  },
  onRegistered: (invalidate: () => void) => {
    invalidateFn = invalidate;
  },
});

// Later, when your data changes:
invalidateFn?.();  // Triggers footer re-render
```

If you register a segment with a `name` that already exists, it replaces the existing segment.

---

## Runtime Events

Runtime events are emitted by pi-flows during flow execution. Listen to these to react to flow lifecycle, track agent activity, or build integrations.

### flow:run

Programmatically trigger a flow by name. Ignored if a flow is already running.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{ flowName: string, ctx?: any }` |
| **Effect** | Starts the named flow. No-op if another flow is currently running. |

```typescript
pi.events?.emit("flow:run", {
  flowName: "my-pkg:build",
  ctx: lastCtx,  // Pass the extension context if available
});
```

### flow:complete

Fired when a flow finishes execution (success or failure). This is the primary event for reacting to flow results.

| Property | Detail |
|----------|--------|
| **Direction** | pi-flows → You |
| **Data shape** | `FlowResult` (see [Key Type Shapes](#flowresult)) |
| **When** | After all flow steps have completed and results are collected. |

```typescript
pi.events?.on("flow:complete", (data: unknown) => {
  const result = data as FlowResult;
  console.log(`Flow "${result.flowName}" completed in ${result.totalDuration}ms`);
  console.log(`Steps: ${result.stepCount}`);

  for (const [stepId, stepResult] of Object.entries(result.results)) {
    console.log(`  ${stepId}: ${stepResult.status}`);
  }
});
```

### flow:rediscover

Trigger re-scanning of all agent and flow directories. Any newly discovered flows are registered as slash commands.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows |
| **Data shape** | `{}` |
| **Effect** | Re-runs discovery across all registered directories. New agents/flows become available. |

```typescript
// After dynamically adding files to an agents directory:
pi.events?.emit("flow:rediscover", {});
```

### flow:subagent-tool-call

Fired every time an agent subprocess calls a tool during flow execution.

| Property | Detail |
|----------|--------|
| **Direction** | pi-flows → You |
| **Data shape** | `{ agentName: string, toolName: string, input: any }` |
| **When** | During flow execution, when any agent invokes a tool (read, write, edit, bash, etc.). |

```typescript
pi.events?.on("flow:subagent-tool-call", (data: any) => {
  const { agentName, toolName, input } = data;
  console.log(`Agent "${agentName}" calling tool "${toolName}"`);
});
```

### flow:subagent-tool-result

Fired when a tool call returns inside an agent subprocess.

| Property | Detail |
|----------|--------|
| **Direction** | pi-flows → You |
| **Data shape** | `{ agentName: string, toolName: string, output: any, isError: boolean }` |
| **When** | After a tool call completes inside an agent subprocess. |

```typescript
pi.events?.on("flow:subagent-tool-result", (data: any) => {
  const { agentName, toolName, output, isError } = data;
  if (isError) {
    console.warn(`Tool "${toolName}" failed for agent "${agentName}"`);
  }
});
```

### flow:loop-iteration

Fired when an `agent-loop-decision` step advances to the next iteration.

| Property | Detail |
|----------|--------|
| **Direction** | pi-flows → You |
| **Data shape** | `{ stepId: string, iteration: number, maxIterations: number }` |
| **When** | When a loop decision agent decides to loop back to the `loop_target` step. |

```typescript
pi.events?.on("flow:loop-iteration", (data: any) => {
  const { stepId, iteration, maxIterations } = data;
  console.log(`Loop "${stepId}": iteration ${iteration}/${maxIterations}`);
});
```

---

## Query Events

Query events use a synchronous emit-and-read-back pattern. You emit an object, and pi-flows mutates it synchronously to populate the response. This avoids the need for request/response event pairs.

### flow:get-agents

Retrieve all discovered agents.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows (synchronous) |
| **Data shape** | Emit `{}`, read `data.agents` as `Map<string, AgentConfig>` |
| **Effect** | The `agents` property is set on the emitted object. |

```typescript
const query: any = {};
pi.events.emit("flow:get-agents", query);
const agents: Map<string, AgentConfig> = query.agents;

for (const [name, config] of agents) {
  console.log(`Agent: ${name} — ${config.description}`);
}
```

### flow:get-flows

Retrieve all discovered flows.

| Property | Detail |
|----------|--------|
| **Direction** | You → pi-flows (synchronous) |
| **Data shape** | Emit `{}`, read `data.flows` as `Map<string, FlowConfig>` |
| **Effect** | The `flows` property is set on the emitted object. |

```typescript
const query: any = {};
pi.events.emit("flow:get-flows", query);
const flows: Map<string, FlowConfig> = query.flows;

for (const [name, config] of flows) {
  console.log(`Flow: ${name} — ${config.description}`);
}
```

---

## Key Type Shapes

### FlowResult

Returned by `flow:complete`. Contains all results from a completed flow.

```typescript
interface FlowResult {
  lastResult: AgentResult;
  results: Record<string, {
    fullOutput: string;
    status: string;       // "complete" | "error" | "blocked"
    summary: string;
    artifacts: string;
    files: string;
  }>;
  forks: Record<string, { answer: string; notes?: string }>;
  flowName: string;
  stepCount: number;
  totalDuration: number;  // Wall-clock milliseconds for entire flow
}
```

### AgentResult

Result from a single agent execution.

```typescript
interface AgentResult {
  success: boolean;
  output: string;
  stderr: string;
  exitCode: number | null;
  result: ParsedResult;
  toolCalls: ToolCallRecord[];
  duration: number;    // ms
  tokens: { input: number; output: number };
  finishParams?: Record<string, any>;
}
```

For complete type definitions, see [public-api.md](public-api.md).
