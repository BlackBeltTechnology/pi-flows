# Extending pi-flows

A complete guide for building packages that depend on pi-flows. Covers package setup, all registration hooks, and a step-by-step walkthrough using pi-judo as the reference implementation.

---

## Overview

pi-flows exposes an event-based extension API. You register content (agents, flows, cards, tools, gates, guards, footer segments) by emitting `flow:*` events from your package's `activate` function. This keeps packages loosely coupled — pi-flows does not need to import your package, and your package only needs pi-flows' events interface.

The full events reference is in [events-api.md](events-api.md).

---

## Package Setup

### 1. Create the package structure

```
my-package/
├── package.json
├── extensions/
│   └── my-extension/
│       └── index.ts          # activate() entry point
├── agents/                   # Agent .md files
│   └── my-agent.md
├── flows/                    # Flow .yaml files
│   └── my-flow.yaml
└── skills/                   # Optional: skill directories
    └── my-skill/
        ├── SKILL.md
        └── reference.md
```

### 2. Configure package.json

```json
{
  "name": "my-package",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@mariozechner/pi-ai": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@mariozechner/pi-ai": "*",
    "@sinclair/typebox": "*"
  }
}
```

> **Peer dependencies only.** Pi-flows types are consumed at runtime through the shared module instance. You should not add `pi-flows` as a direct dependency — use the event interface and import types directly from the source path when needed.

### 3. Write the activate function

```typescript
// extensions/my-extension/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function activate(pi: ExtensionAPI) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // --- Register agents, flows, and skills ---
  pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
  pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
  pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });
}
```

The `pkgRoot` calculation assumes your extension file is two directories deep inside the package root (`extensions/my-extension/index.ts` → `../../` → package root). Adjust the `"..", ".."` count to match your layout.

---

## Registration Patterns

### Registering Agents and Flows

The most common pattern — add directories for pi-flows to discover:

```typescript
pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
```

**Discovery priority** (later registrations win on name collision):

1. Extra package agents/flows (registered via events) — in registration order
2. pi-flows built-in agents/flows
3. Project-local files (`.pi/flows/agents/`, `.pi/flows/flows/`) — **always wins**

This means users can always override your defaults by dropping a file in `.pi/flows/`.

### Registering Skills

Skills provide injected documentation for agents:

```typescript
pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });
```

Each skill is a directory containing at minimum a `SKILL.md` file. Agents reference skills by directory name:

```
skills/
└── my-backend-docs/
    ├── SKILL.md          # Injected into agent system prompt
    ├── api-reference.md  # Available via skill_read tool
    └── examples.md
```

`SKILL.md` must list available detail files so agents know what to request with `skill_read`:

```markdown
# My Backend Docs

Core reference injected into every agent that uses this skill.

## Available Reference Files

Read with `skill_read`:
- `api-reference.md` — Full API reference
- `examples.md` — Code examples
```

### Registering Custom Card Renderers

Custom card renderers display domain-specific metrics in the flow dashboard. Each agent card can show one metric line (a short string).

```typescript
import type { AgentCardRenderer } from "pi-flows/extensions/flow-dashboard/types.js";

export class MyCard implements AgentCardRenderer {
  private count = 0;

  onToolCall(toolName: string, input: any): void {
    if (toolName === "my_tool") this.count++;
  }

  onToolResult(_toolName: string, _output: any): void {}

  onComplete(_result: any): void {}

  renderMetric(width: number): string {
    return `  calls:${this.count}`.slice(0, width);
  }
}

// Register:
pi.events?.emit("flow:register-card", {
  name: "my-card-type",
  factory: () => new MyCard(),
});
```

Agents reference the renderer in their frontmatter:

```yaml
card:
  label: "My Agent"
  metric: "my-card-type"
```

A new `MyCard` instance is created per agent card via `factory()`.

### Registering a Workflow Pipeline

Workflows add breadcrumb navigation to the dashboard. When a flow belonging to a workflow stage runs, the breadcrumb shows the full pipeline with the active stage highlighted:

```
research → [apply] → verify
```

```typescript
pi.events?.emit("flow:register-workflow", {
  id: "my-pipeline",
  stages: [
    { name: "research", flows: ["my-pkg:research"] },
    { name: "apply",    flows: ["my-pkg:apply"] },
    { name: "verify",   flows: ["my-pkg:verify"] },
  ],
});
```

The `flows` array lists flow names that trigger each stage (use the same names as the registered commands without the leading `/`).

### Registering Gates

Gates are prerequisite checks that block flows from running if conditions aren't met:

```typescript
import { existsSync } from "node:fs";

const hasConfig = existsSync(join(cwd, "my-package.config.json"));

pi.events?.emit("flow:register-gate", {
  name: "my-package-config",
  check: () => hasConfig,
  flows: ["my-pkg:*"],  // applies to all my-pkg: flows
  message: "No my-package.config.json found. Run /my-pkg:setup first.",
});
```

The `check` function is called synchronously at the moment the user runs the flow command. Keep it fast (file existence, in-memory state). The `flows` array supports a trailing `*` wildcard.

### Registering Guard Extensions

Guards intercept tool calls inside spawned agent subprocesses. Use them to enforce domain-specific access policies:

```typescript
pi.events?.emit("flow:register-guard-extension", {
  factory: (piApi: ExtensionAPI) => {
    piApi.on("tool_call", (event: any, ctx: any, next: () => void) => {
      if (event.name === "write" && event.params.path?.endsWith(".config")) {
        ctx.block("Config files are read-only. Use the setup flow to modify them.");
        return;
      }
      next();
    });
  },
});
```

The factory is called once per spawned agent session. `piApi` is a scoped `ExtensionAPI` for that session. Guards apply to all agents spawned by pi-flows in this session — they cannot be scoped to individual agents.

### Registering Footer Segments

Footer segments appear in the status bar after pi-flows' built-in segments (provider, git branch, file stats, context usage):

```typescript
let invalidate: (() => void) | null = null;

pi.events?.emit("flow:register-footer-segment", {
  name: "my-status",
  render: () => {
    const count = getMyCount();
    return count > 0 ? `${count} items` : null;  // null hides the segment
  },
  onRegistered: (fn) => { invalidate = fn; },
});

// Trigger re-render when data changes:
onDataChange(() => invalidate?.());
```

Use `onRegistered` to receive the `invalidate` function — call it whenever your segment data changes to trigger a footer re-render.

### Registering Custom Agent Tools

Extension tools registered via `pi.registerTool()` are **automatically discovered** and made available to any agent that lists the tool in its `tools:` frontmatter field. No additional registration step is needed — the flow engine collects all tools from `pi.getAllTools()` at session start.

```typescript
import { Type } from "@sinclair/typebox";

pi.registerTool({
  name: "my_tool",
  description: "Do something useful for agents.",
  parameters: Type.Object({
    action: Type.String({ description: "The action to perform" }),
    target: Type.Optional(Type.String()),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const result = await doSomething(params.action, params.target);
    return {
      content: [{ type: "text" as const, text: result }],
      details: {},
    };
  },
});
```

Agents declare it in frontmatter:

```yaml
tools: read, write, my_tool
```

The guard still enforces per-agent whitelisting — only tools declared in the agent's `tools:` frontmatter are allowed through. Auto-discovery just makes them **available** to be allowed.

> **Note:** The `flow:register-tool` event is deprecated. Tools registered via `pi.registerTool()` are automatically available to subagent sessions. The event still works for backward compatibility but is no longer needed.

### Listening to Flow Completion

React to completed flows to trigger follow-up actions, sync state, or run post-processing:

```typescript
pi.events?.on("flow:complete", (data: unknown) => {
  const result = data as any; // FlowResult
  if (result.flowName === "my-pkg:apply" && result.status === "success") {
    // Flow completed successfully — trigger downstream work
    const developerSummary = result.results["developer"]?.summary;
    if (developerSummary) {
      updateState(developerSummary);
    }
  }
});
```

`flow:complete` fires even on error and abort, so always check `result.status`.

---

## Complete Example: pi-judo

pi-judo is the canonical reference implementation. It uses every registration hook.

### Package layout

```
pi-judo/
├── package.json
├── extensions/
│   └── judospec/
│       ├── index.ts          # activate()
│       ├── footer.ts         # Footer segment helpers
│       ├── guards.ts         # Model file protection guard
│       ├── cards/            # Custom card metric renderers
│       │   ├── model-card.ts
│       │   ├── developer-card.ts
│       │   └── ...
│       ├── tools/
│       │   └── model-cli.ts  # Custom model_cli tool
│       └── ...
├── agents/                   # Judo-specific agents
├── flows/                    # Judo flows (registered as /judo:* commands)
└── skills/                   # Judo skill documentation
```

### activate function walkthrough

```typescript
// extensions/judospec/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync, existsSync } from "node:fs";
import { ModelCard } from "./cards/model-card.js";
import { createModelProtectionGuard } from "./guards.js";
import { createModelCliTool } from "./tools/model-cli.js";
import { setupFooter } from "./footer.js";

export default function activate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const __filename = fileURLToPath(import.meta.url);
  const judoPkgRoot = join(dirname(__filename), "..", "..");

  // 1. Register content directories
  pi.events?.emit("flow:register-agents-dir", { dir: join(judoPkgRoot, "agents") });
  pi.events?.emit("flow:register-flows-dir", { dir: join(judoPkgRoot, "flows") });
  pi.events?.emit("flow:register-skills-dir", { dir: join(judoPkgRoot, "skills") });

  // 2. Register custom card metric renderers
  pi.events?.emit("flow:register-card", { name: "model",      factory: () => new ModelCard() });
  pi.events?.emit("flow:register-card", { name: "developer",  factory: () => new DeveloperCard() });
  pi.events?.emit("flow:register-card", { name: "researcher", factory: () => new ResearcherCard() });
  pi.events?.emit("flow:register-card", { name: "tester",     factory: () => new TesterCard() });

  // 3. Register workflow pipeline for breadcrumb
  pi.events?.emit("flow:register-workflow", {
    id: "sdd",
    stages: [
      { name: "research", flows: ["judo:research-all"] },
      { name: "apply",    flows: ["judo:apply"] },
      { name: "verify",   flows: ["judo:verify"] },
    ],
  });

  // 4. Register prerequisite gates
  const models = globSync(join(cwd, "model", "*.model"));
  const judoEnabled = models.length > 0;

  pi.events?.emit("flow:register-gate", {
    name: "judo-project",
    check: () => judoEnabled,
    flows: ["judo:*"],
    message: "No JUDO model files found. JUDO flows require a JUDO project.",
  });

  pi.events?.emit("flow:register-gate", {
    name: "judo-research",
    check: () => existsSync(join(cwd, "judospec", "research")),
    flows: ["judo:apply"],
    message: "No research directory found. Run /judo:research-all first.",
  });

  // 5. Register guard and custom tool (only for JUDO projects)
  if (judoEnabled) {
    // Guard: blocks direct .model file access in agent subprocesses
    pi.events?.emit("flow:register-guard-extension", {
      factory: (piApi: ExtensionAPI) => {
        piApi.on("tool_call", createModelProtectionGuard());
      },
    });

    // Custom tool: auto-discovered by flow engine, available to agents that declare "model_cli" in tools:
    const modelCliTool = createModelCliTool(cwd);
    pi.registerTool(modelCliTool);
  }

  // 6. Register footer segments
  setupFooter(pi, serverManager, getMutationCount);

  // 7. React to flow completion
  pi.events?.on("flow:complete", (data: unknown) => {
    const result = data as any;
    if (result.flowName === "judo:apply" && result.status === "success") {
      // Refresh registry after apply
      registry.reload();
    }
  });
}
```

---

## Dashboard Integration Points

### Summary: All integration points

| Hook | Event | Data |
|------|-------|------|
| Agent files | `flow:register-agents-dir` | `{ dir }` |
| Flow files | `flow:register-flows-dir` | `{ dir }` |
| Skill docs | `flow:register-skills-dir` | `{ dir }` |
| Card metric | `flow:register-card` | `{ name, factory }` |
| Workflow breadcrumb | `flow:register-workflow` | `WorkflowDefinition` |
| Prerequisite check | `flow:register-gate` | `{ name, check, flows, message }` |
| Sandbox guard | `flow:register-guard-extension` | `{ factory }` |
| Footer segment | `flow:register-footer-segment` | `{ name, render, onRegistered? }` |
| Agent tool | `pi.registerTool()` (auto-discovered) | Tool definition |
| Flow lifecycle | `flow:complete` (listen) | `FlowResult` |
| Tool observation | `flow:subagent-tool-call` (listen) | `{ agentName, toolName, input }` |

### Typing card renderers

Import the `AgentCardRenderer` type from pi-flows:

```typescript
import type { AgentCardRenderer } from "pi-flows/extensions/flow-dashboard/types.js";
```

Or inline the interface (avoids import path coupling):

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: any): void;
  renderMetric(width: number): string;
}
```

### Importing exported types from pi-flows

For typed access to `FlowResult`, `AgentConfig`, etc.:

```typescript
import type {
  FlowResult,
  AgentConfig,
  FlowConfig,
  AgentResult,
} from "pi-flows/extensions/flow-engine/index.js";
```

See [public-api.md](public-api.md) for the full exported surface.

---

## Tips and Gotchas

**Emit registration events synchronously** — pi-flows processes them during the same turn as `activate`. An `await` before a `flow:register-*` emit means the event fires after initial discovery, which may be too late for some hooks (e.g., gates are checked at command invocation time, so they can be registered after `activate`, but flows need to be registered before the user can call them).

**Use `pkgRoot`, not `import.meta.url` directly** — `import.meta.url` gives the path of the current file, not the package root. Always traverse up with `join(dirname(...), "..", "..")` to the package root, then join to `agents/`, `flows/`, etc.

**Guard factories get a fresh `pi` per agent session** — Each spawned agent subprocess has its own `ExtensionAPI` scope. The factory is called fresh for each agent. Don't share mutable state between guard instances.

**Multiple `flow:register-card` calls for the same name replace** — If your package registers a card with `name: "default"`, it replaces pi-flows' default renderer. This is intentional for overrides, but can be surprising.

**`flow:complete` fires on abort** — Always check `result.status` before acting on the result. A status of `"aborted"` means the user pressed Ctrl+X; `"error"` means the flow threw. Neither guarantees that any steps completed successfully.
