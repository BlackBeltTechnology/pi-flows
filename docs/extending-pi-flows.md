# Extending pi-flows

Guide for building a pi package that depends on pi-flows. This covers package setup, resource registration, custom dashboard cards, workflows, gates, footer segments, and event handling.

Throughout this guide, [pi-judo](https://github.com/BlackBeltTechnology/pi-judo) is referenced as a real-world example of a package built on top of pi-flows.

> **Architecture note:** pi-flows uses a single extension entry point (`extensions/index.ts`) that loads all internal sub-extensions in one jiti module graph. This means all internal modules share state through normal imports. External packages (like yours) communicate with pi-flows exclusively through `pi.events` — you never need to import pi-flows modules directly at runtime (only `import type` for TypeScript types).

## Table of Contents

- [Package Setup](#package-setup)
- [Registration Pattern](#registration-pattern)
- [Registering Agents, Flows, and Skills](#registering-agents-flows-and-skills)
- [Custom Card Renderers](#custom-card-renderers)
- [Workflow Definitions](#workflow-definitions)
- [Gates (Prerequisite Checks)](#gates-prerequisite-checks)
- [Guard Extensions](#guard-extensions)
- [Session Context](#session-context)
- [Footer Segments](#footer-segments)
- [Listening to Flow Events](#listening-to-flow-events)
- [Querying Discovery State](#querying-discovery-state)
- [Complete Example](#complete-example)

---

## Package Setup

### package.json

Your package needs:
1. A `pi` manifest declaring your extensions directory
2. pi-flows as a dependency
3. pi core packages as peer dependencies

```json
{
  "name": "my-domain-package",
  "version": "0.1.0",
  "description": "Domain-specific flows for pi",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/my-domain"]
  },
  "dependencies": {
    "pi-flows": "git+ssh://git@github.com:BlackBeltTechnology/pi-flows.git"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  }
}
```

> **pi-judo reference:** See [pi-judo/package.json](https://github.com/BlackBeltTechnology/pi-judo/blob/main/package.json) for a working example.

### Directory Structure

```
my-domain-package/
├── package.json
├── extensions/
│   └── my-domain/
│       ├── index.ts          # Extension entry point
│       └── cards/            # Custom card renderers
│           └── my-card.ts
├── agents/                   # Agent .md files
│   ├── my-researcher.md
│   └── my-developer.md
├── flows/                    # Flow .flow.md files
│   └── my-pipeline.flow.md
└── skills/                   # Skill directories
    └── my-docs/
        └── SKILL.md
```

---

## Registration Pattern

All registration happens in your extension's `activate(pi)` function by emitting events. pi-flows listens for these events and integrates your resources.

**Key principle:** Use `import.meta.url` to resolve paths relative to your package root. This ensures correct paths regardless of where the package is installed.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function activate(pi: ExtensionAPI) {
  // Resolve package root from this file's location
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = join(dirname(__filename), "..", "..");

  // Register resources
  pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
  pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
  pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });

  // Register dashboard cards, workflows, gates, footer segments...
}
```

> **pi-judo reference:** [pi-judo/extensions/judospec/index.ts](https://github.com/BlackBeltTechnology/pi-judo/blob/main/extensions/judospec/index.ts) lines 30–34 show this exact pattern.

---

## Registering Agents, Flows, and Skills

### Agents

Place agent `.md` files in your agents directory. After registering with `flow:register-agents-dir`, they're discovered alongside pi-flows' built-in agents and any project-local agents.

**Discovery priority** (last wins on name collision):
1. Extra package agents (your registered directories)
2. pi-flows package agents (`pi-flows/agents/`)
3. Project-local agents (`.pi/flows/agents/`)

### Flows

Place flow `.flow.md` files in your flows directory. After registering with `flow:register-flows-dir`, each flow auto-registers as a slash command.

**Naming convention:** Prefix flow names with your package identifier to avoid collisions (e.g., `my-pkg:research`, `my-pkg:build`).

### Skills

Place skill directories (each containing a `SKILL.md`) in your skills directory. After registering with `flow:register-skills-dir`, they're available to agents via the `skills:` frontmatter field and the `skill_read` tool.

---

## Custom Card Renderers

The dashboard shows agent cards during flow execution. Each card can display domain-specific metrics via a custom `AgentCardRenderer`.

### The AgentCardRenderer Interface

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;  // Single line for the dashboard card
}
```

**Lifecycle:**
1. `onToolCall` — called when the agent invokes a tool
2. `onToolResult` — called when a tool returns (track metrics here)
3. `onComplete` — called when the agent finishes (final summary)
4. `renderMetric` — called every render tick to display the metric line

### Implementing a Custom Card

```typescript
import type { AgentResult } from "pi-flows/extensions/flow-engine/types.js";

export class DeployCard implements AgentCardRenderer {
  private deployCount = 0;
  private lastTarget = "";

  onToolCall(toolName: string, input: any): void {
    // Track when the agent runs deploy commands
    if (toolName === "bash" && input.command?.includes("deploy")) {
      this.deployCount++;
    }
  }

  onToolResult(toolName: string, output: any): void {
    // Extract deploy target from output
    if (typeof output === "string" && output.includes("Deployed to")) {
      const match = output.match(/Deployed to (\S+)/);
      if (match) this.lastTarget = match[1];
    }
  }

  onComplete(result: AgentResult): void {
    // Nothing extra on completion
  }

  renderMetric(width: number): string {
    if (this.deployCount === 0) return "";
    return `${this.deployCount} deploys → ${this.lastTarget || "pending"}`;
  }
}
```

### Registering the Card

```typescript
import { DeployCard } from "./cards/deploy-card.js";

pi.events?.emit("flow:register-card", {
  name: "deploy",
  factory: () => new DeployCard(),
});
```

Then reference it in your agent's frontmatter:

```yaml
card:
  label: "Deploy"
  metric: "deploy"
```

**Built-in metric renderers:** `default` (tool call count), `files` (file modification tracking), `tests` (test result tracking).

> **pi-judo reference:** pi-judo registers 7 custom cards: `model`, `researcher`, `developer`, `writer`, `chain`, `tester`, `verifier`. See [pi-judo/extensions/judospec/cards/](https://github.com/BlackBeltTechnology/pi-judo/tree/main/extensions/judospec/cards).

---

## Workflow Definitions

Workflows define multi-stage pipelines that appear as breadcrumb navigation in the dashboard. When a flow matching a stage's `flows` array runs, the breadcrumb highlights that stage.

### WorkflowDefinition Type

```typescript
interface WorkflowDefinition {
  id: string;                     // Unique workflow identifier
  stages: WorkflowStage[];        // Ordered pipeline stages
}

interface WorkflowStage {
  name: string;                   // Display name
  flows: string[];                // Flow names that trigger this stage
  detailFn?: (ctx: any) => string;  // Dynamic detail text
}
```

### Registration

```typescript
pi.events?.emit("flow:register-workflow", {
  id: "my-pipeline",
  stages: [
    { name: "research", flows: ["my-pkg:research", "my-pkg:research-all"] },
    { name: "implement", flows: ["my-pkg:implement"] },
    { name: "verify", flows: ["my-pkg:verify"] },
  ],
});
```

When the user runs `/my-pkg:implement`, the dashboard breadcrumb shows:

```
research → [implement] → verify
```

> **pi-judo reference:** pi-judo registers two workflows (`research-all` and `research`) at [index.ts lines 59–75](https://github.com/BlackBeltTechnology/pi-judo/blob/main/extensions/judospec/index.ts).

---

## Gates (Prerequisite Checks)

Gates block flows from running until conditions are met. Use them to enforce project structure requirements, check for dependencies, or validate configuration.

### GateEntry Type

```typescript
interface GateEntry {
  name: string;            // Unique gate identifier
  check: () => boolean;    // Returns true if gate passes
  flows: string[];         // Glob patterns for flow names
  message: string;         // User-facing message when blocked
}
```

### Registration

```typescript
import { existsSync, globSync } from "node:fs";

// Gate: require project files
pi.events?.emit("flow:register-gate", {
  name: "my-project-check",
  check: () => {
    try {
      return globSync(join(cwd, "model", "*.model")).length > 0;
    } catch {
      return false;
    }
  },
  flows: ["my-pkg:*"],
  message: "No project files found. Run from a project root.",
});

// Gate: require research before implementation
pi.events?.emit("flow:register-gate", {
  name: "my-research-check",
  check: () => existsSync(join(cwd, "research")),
  flows: ["my-pkg:implement"],
  message: "No research found. Run /my-pkg:research first.",
});
```

**Glob matching:** `"my-pkg:*"` matches any flow name starting with `"my-pkg:"`. Exact strings match only that flow name.

> **pi-judo reference:** pi-judo registers two gates — a project gate and a research gate at [index.ts lines 77–92](https://github.com/BlackBeltTechnology/pi-judo/blob/main/extensions/judospec/index.ts).

---

## Guard Extensions

Guard extensions are `ExtensionFactory` functions applied to every agent session your package's flows dispatch. They let you enforce custom sandboxing rules — restrict tool access, block writes to sensitive paths, or add domain-specific validation — on top of the built-in guard that pi-flows already injects.

Agents run as **in-process SDK sessions** (not separate subprocesses), so guards are wired directly into the session's extension runtime before the agent starts.

### Registering a Guard Extension

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

pi.events?.emit("flow:register-guard-extension", {
  factory: (piApi: ExtensionAPI) => {
    piApi.on("tool_call", (event: any) => {
      const toolName = event.toolName || event.name;
      const params = event.params || event.input || {};

      // Block all writes to the protected model directory
      if ((toolName === "write" || toolName === "edit") &&
          (params.file_path || "").startsWith("model/")) {
        return { block: true, reason: "Direct writes to model/ are blocked. Use the model update flow instead." };
      }

      return undefined;  // Allow the tool call
    });
  },
});
```

The `factory` value is `(pi: ExtensionAPI) => void`. It can call `pi.on("tool_call", handler)` to intercept tool calls. The handler receives the event and should return `{ block: true, reason }` to block or `undefined` to allow.

### Using createGuardExtension

For common patterns (tool whitelists, access rules), you can use pi-flows' own guard factory directly:

```typescript
import { createGuardExtension } from "pi-flows/extensions/flow-engine/guard.js";

pi.events?.emit("flow:register-guard-extension", {
  factory: createGuardExtension({
    accessRules: {
      read: ["src/**", "docs/**"],
      write: ["src/**"],
      bash: { deny: ["curl", "wget"] },
    },
  }),
});
```

See [public-api.md — Guard Extension API](public-api.md#guard-extension-api) for the full `GuardOptions` reference.

> **pi-judo reference:** pi-judo registers a model protection guard via `flow:register-guard-extension` with `factory` to prevent agents from directly modifying model artifacts.

---

## Session Context

When your extension dispatches agents directly (e.g., in a slash command that calls `spawnAgent()` without going through a `.flow.md` file), you need the live session's `authStorage` and `modelRegistry`. There are two ways to get them.

### Option A: Capture session_start yourself

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnAgent } from "pi-flows/extensions/flow-engine/execution.js";

export default function activate(pi: ExtensionAPI) {
  let authStorage: any;
  let modelRegistry: any;

  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.modelRegistry) {
      modelRegistry = ctx.modelRegistry;
      authStorage = (ctx.modelRegistry as any).authStorage;
    }
  });

  pi.registerCommand("/my-run", async (_ctx: any) => {
    const result = await spawnAgent({
      agent: myAgent,
      task: "Do the thing",
      templateContext: { task: "Do the thing", inputs: {}, results: {}, forks: {} },
      cwd: process.cwd(),
      authStorage,
      modelRegistry,
    });
  });
}
```

### Option B: Query pi-flows for the captured context

If pi-flows is loaded before your extension (which it is, since you depend on it), you can retrieve the already-captured context via the `flow:get-spawn-context` query event. This is simpler and automatically includes `extraGuardFactories` from all registered packages:

```typescript
pi.registerCommand("/my-run", async (_ctx: any) => {
  const spawnCtx: any = {};
  pi.events.emit("flow:get-spawn-context", spawnCtx);
  const { authStorage, modelRegistry, extraGuardFactories } = spawnCtx;

  const result = await spawnAgent({
    agent: myAgent,
    task: "Do the thing",
    templateContext: { task: "Do the thing", inputs: {}, results: {}, forks: {} },
    cwd: process.cwd(),
    authStorage,
    modelRegistry,
    extraGuardFactories,
  });
});
```

See [events-api.md — flow:get-spawn-context](events-api.md#flowget-spawn-context) for the full event reference.

---

## Footer Segments

Footer segments add custom status indicators to the footer bar below the editor.

### Registration

```typescript
let invalidateFn: (() => void) | null = null;

pi.events?.emit("flow:register-footer-segment", {
  name: "my-status",
  render: () => {
    const count = getActiveCount();
    return `${count} active`;
  },
  onRegistered: (invalidate: () => void) => {
    invalidateFn = invalidate;
  },
});
```

**Key points:**

- `render()` returns a plain string. Theme colors are not available inside the render function — use plain text indicators (e.g., `●`, `○`, `◐`, `✗`).
- `onRegistered` is called with an `invalidate()` function. Call it whenever your data changes to trigger a footer re-render.
- If you register a segment with the same `name`, it replaces the existing one.

### Triggering Re-renders

```typescript
// When your state changes, call invalidate:
someStateManager.onChange(() => invalidateFn?.());
```

> **pi-judo reference:** pi-judo registers two footer segments (`judo-mutations` and `judo-server`) in [extensions/judospec/footer.ts](https://github.com/BlackBeltTechnology/pi-judo/blob/main/extensions/judospec/footer.ts).

---

## Listening to Flow Events

### flow:complete

React to finished flows. Receives the full `FlowResult` with all step results.

```typescript
pi.events?.on("flow:complete", (data: any) => {
  const result = data as FlowResult;

  if (!result?.results) return;

  // Process step results
  for (const [stepId, stepResult] of Object.entries(result.results)) {
    console.log(`${stepId}: ${stepResult.status}`);

    // Track file modifications
    if (stepResult.files) {
      for (const entry of stepResult.files.split(", ").filter(Boolean)) {
        const match = entry.match(/^(.+?)\s+\((created|modified|read)\)$/);
        if (match) {
          console.log(`  File: ${match[1]} (${match[2]})`);
        }
      }
    }
  }
});
```

### flow:subagent-tool-call / flow:subagent-tool-result

Track tool activity across all agents during flow execution.

```typescript
pi.events?.on("flow:subagent-tool-call", (data: any) => {
  const { agentName, toolName, input } = data;
  // Track calls per agent, build metrics, etc.
});

pi.events?.on("flow:subagent-tool-result", (data: any) => {
  const { agentName, toolName, output, isError } = data;
  // Track results, errors, file modifications, etc.
});
```

> **pi-judo reference:** pi-judo listens to `flow:complete` to track file modifications across all agents at [index.ts lines 142–160](https://github.com/BlackBeltTechnology/pi-judo/blob/main/extensions/judospec/index.ts).

---

## Querying Discovery State

Use the synchronous query events to inspect what agents and flows are available:

```typescript
// Get all discovered agents
const agentQuery: any = {};
pi.events.emit("flow:get-agents", agentQuery);
const agents: Map<string, AgentConfig> = agentQuery.agents;

// Get all discovered flows
const flowQuery: any = {};
pi.events.emit("flow:get-flows", flowQuery);
const flows: Map<string, FlowConfig> = flowQuery.flows;
```

---

## Complete Example

Here's a minimal but complete extension that registers agents, flows, skills, a custom card, a workflow, a gate, and a footer segment:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MyMetricCard } from "./cards/my-metric-card.js";

export default function activate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = join(dirname(__filename), "..", "..");

  // ── Register resources ─────────────────────────────────────────
  pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
  pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
  pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });

  // ── Custom card renderer ───────────────────────────────────────
  pi.events?.emit("flow:register-card", {
    name: "my-metric",
    factory: () => new MyMetricCard(),
  });

  // ── Workflow definition ────────────────────────────────────────
  pi.events?.emit("flow:register-workflow", {
    id: "my-pipeline",
    stages: [
      { name: "research", flows: ["my-pkg:research"] },
      { name: "build", flows: ["my-pkg:build"] },
    ],
  });

  // ── Gate: require project config ───────────────────────────────
  pi.events?.emit("flow:register-gate", {
    name: "my-project-check",
    check: () => existsSync(join(cwd, "my-config.json")),
    flows: ["my-pkg:*"],
    message: "No my-config.json found. Run from a project root.",
  });

  // ── Footer segment ────────────────────────────────────────────
  let invalidate: (() => void) | null = null;
  let itemCount = 0;

  pi.events?.emit("flow:register-footer-segment", {
    name: "my-items",
    render: () => `${itemCount} items`,
    onRegistered: (inv: () => void) => { invalidate = inv; },
  });

  // ── React to flow completions ──────────────────────────────────
  pi.events?.on("flow:complete", (data: any) => {
    if (!data?.results) return;
    itemCount = Object.keys(data.results).length;
    invalidate?.();
  });
}
```
