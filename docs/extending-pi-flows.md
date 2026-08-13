# Extending pi-flows

This guide covers how to build npm packages that plug into pi-flows — registering custom agents, flows, skills, tools, cards, workflows, and guards. A well-structured extension package gives domain teams a clean way to add project-specific capabilities without forking pi-flows itself.

---

## 1. Package structure

```
my-domain-package/
├── package.json
├── agents/
│   ├── my-researcher.md
│   └── my-implementer.md
├── flows/
│   └── my-domain/
│       └── build.yaml
├── skills/
│   └── my-docs/
│       ├── SKILL.md
│       └── api-reference.md
├── extensions/
│   ├── index.ts          ← main extension (activate)
│   └── my-guard.ts       ← subagent guard (optional)
└── tsconfig.json
```

---

## 2. `package.json` setup

Declare pi-flows and pi-coding-agent as **peer dependencies** (not regular dependencies). This ensures your package uses the same instances already loaded by the host.

```json
{
  "name": "my-domain-package",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/index"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "pi-flows": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "pi-flows": "*",
    "@sinclair/typebox": "*",
    "typescript": "^5.0.0"
  },
  "type": "module"
}
```

The `pi.extensions` array tells the pi loader which entry points to activate. Paths are relative to the package root, resolved at runtime.

---

## 3. Main extension entry point

```typescript
// extensions/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export default function myDomainExtension(pi: ExtensionAPI) {
  // ── 1. Register agents, flows, skills ──────────────────────────────
  pi.events.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
  pi.events.emit("flow:register-flows-dir",  { dir: join(pkgRoot, "flows") });
  pi.events.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });

  // ── 2. Register a custom tool for agent sessions ────────────────────
  pi.events.emit("flow:register-tool", {
    tool: {
      name: "my_domain_query",
      description: "Query domain-specific data by entity ID.",
      parameters: Type.Object({
        entityId: Type.String({ description: "Entity to query" }),
      }),
      execute: async (_id, params) => {
        const result = await fetchDomainData(params.entityId);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      },
    },
  });

  // ── 3. Register a precondition gate ────────────────────────────────
  pi.events.emit("flow:register-gate", {
    name:    "auth-required",
    check:   () => isAuthenticated(),
    flows:   ["my-domain:*"],    // blocks all my-domain flows
    message: "Login required. Run /my-domain:login first.",
  });

  // ── 4. Register a guard for agent sessions ─────────────────────────
  pi.events.emit("flow:register-agent-extension", {
    factory: async (agentPi: ExtensionAPI) => {
      agentPi.on("tool_call", (event: any) => {
        const toolName = event.toolName || event.name;
        if (toolName === "bash") {
          const cmd = event.params?.command ?? "";
          if (cmd.includes("my-secret-service")) {
            return { block: true, reason: "Direct access to my-secret-service is not allowed." };
          }
        }
      });
    },
  });

  // ── 5. Register a custom slash-command ─────────────────────────────
  pi.registerCommand("my-domain:status", {
    description: "Show domain connection status",
    handler: async (_args, ctx) => {
      const ok = await checkDomainConnection();
      ctx.ui.notify(ok ? "Domain: connected" : "Domain: offline", ok ? "info" : "error");
    },
  });

  // ── 6. Register a custom card renderer ─────────────────────────────
  pi.events.emit("flow:register-card", {
    name:    "my-metric",
    factory: () => new MyMetricRenderer(),
  });

  // ── 7. Register a workflow pipeline for the dashboard ──────────────
  pi.events.emit("flow:register-workflow", {
    id: "my-pipeline",
    stages: [
      { name: "Research",   flows: ["my-domain:research"] },
      { name: "Implement",  flows: ["my-domain:implement"] },
      { name: "Verify",     flows: ["my-domain:verify"] },
    ],
  });
}
```

---

## 4. Registration patterns in depth

### 4a. Agents directory

```typescript
pi.events.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
```

- Scans all `*.md` files in the directory (non-recursive, `.chain.md` files excluded).
- Each file is parsed as an agent definition. See [flow-authoring.md](flow-authoring.md) for the `.md` format.
- Agent names come from the `name:` frontmatter field.
- **Priority order:** extra packages → pi-flows built-ins → project-local (`.pi/flows/agents/`). Later registrations **overwrite** earlier ones on name collision.

### 4b. Flows directory

```typescript
pi.events.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
```

- Scans recursively for `*.yaml` files, up to **one subfolder** deep.
- Flow names are derived from the filesystem path:
  - `flows/build.yaml` → `build`
  - `flows/my-domain/build.yaml` → `my-domain:build`
- Each flow is registered as a slash-command (`/my-domain:build`).
- **Priority:** same as agents — project-local overrides packages.

### 4c. Skills directory

```typescript
pi.events.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });
```

Each subdirectory must contain a `SKILL.md`. When an agent declares the skill, it is advertised in the prompt (name/description/location) and the agent reads `SKILL.md` + its topic files on demand with `read` (auto-granted; skill dir whitelisted).

```
skills/
  my-docs/
    SKILL.md            # index (advertised in agent prompts by location)
    api-reference.md    # topic file (read on-demand with `read`)
    error-codes.md      # topic file (read on-demand with `read`)
```

`SKILL.md` format:
```markdown
---
name: my-docs
description: API reference for my domain
files:
  - api-reference.md
  - error-codes.md
---

# My Domain Documentation

Reference docs for the my-domain framework. Use `read` to open the files below (paths relative to this `SKILL.md`).

## Available Reference Files
- **api-reference.md** — Endpoint signatures and request/response shapes
- **error-codes.md** — Error code catalogue and resolution steps
```

### 4d. Custom tools for agent sessions

```typescript
pi.events.emit("flow:register-tool", {
  tool: {
    name: "my_tool",
    description: "...",
    parameters: Type.Object({ ... }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      return { content: [{ type: "text", text: "result" }], details: {} };
    },
  },
});
```

Tools registered here are **not** available in the main session — only in spawned agent subprocesses. This prevents leaking domain-specific tools to the user-facing LLM.

To declare these tools in agent frontmatter, list them by name in `tools:`:
```markdown
---
name: my-researcher
tools: read, grep, my_domain_query
---
```

### 4e. Cards and workflows

Cards customize the metric display in the agent dashboard. The `card.metric` frontmatter field on an agent selects which renderer to use.

```typescript
// Register renderer
pi.events.emit("flow:register-card", {
  name:    "test-results",
  factory: () => new TestResultRenderer(),
});
```

```markdown
---
name: my-tester
card:
  label: "Test Runner"
  metric: "test-results"
---
```

`AgentCardRenderer` interface to implement:
```typescript
class TestResultRenderer implements AgentCardRenderer {
  private passed = 0;
  private failed = 0;

  onToolCall(toolName: string, _input: any): void {}

  onToolResult(toolName: string, output: any): void {
    if (toolName === "bash") {
      // Parse test output from bash results
      const text = output?.content?.[0]?.text ?? "";
      const passMatch = text.match(/(\d+) passed/);
      const failMatch = text.match(/(\d+) failed/);
      if (passMatch) this.passed = parseInt(passMatch[1]);
      if (failMatch) this.failed = parseInt(failMatch[1]);
    }
  }

  onComplete(_result: AgentResult): void {}

  renderMetric(width: number): string {
    return `✓${this.passed} ✗${this.failed}`.padEnd(width);
  }
}
```

Workflows define pipeline stages shown in the breadcrumb:
```typescript
pi.events.emit("flow:register-workflow", {
  id: "my-pipeline",
  stages: [
    { name: "Research",  flows: ["my-pipeline:research"] },
    { name: "Build",     flows: ["my-pipeline:build"] },
    { name: "Verify",    flows: ["my-pipeline:verify"] },
  ],
});
```

### 4f. Gates

Gates block flows from starting when a precondition fails. Common use: require authentication before running flows that call authenticated APIs.

```typescript
pi.events.emit("flow:register-gate", {
  name:    "my-auth-gate",
  check:   () => hasValidToken(),
  flows:   ["my-domain:*", "some-specific-flow"],
  message: "Auth token required. Run /my-domain:login first.",
});
```

Gates are checked synchronously. The `check` function must return synchronously.

### 4g. Guards (agent extensions)

Guards run inside every spawned agent session. Use them to enforce sandboxing, add provider middleware, or inject session-specific tools.

**Factory pattern (recommended):**
```typescript
pi.events.emit("flow:register-agent-extension", {
  factory: async (pi: ExtensionAPI) => {
    // Block write access outside allowed paths
    pi.on("tool_call", (event: any) => {
      const toolName = event.toolName || event.name;
      if (toolName === "write" || toolName === "edit") {
        const path = event.params?.path ?? event.params?.file_path ?? "";
        if (!path.startsWith("/allowed/path/")) {
          return { block: true, reason: `Write outside /allowed/path/ not permitted: ${path}` };
        }
      }
    });
  },
});
```

**File path pattern:**
```typescript
pi.events.emit("flow:register-agent-extension", {
  path: join(pkgRoot, "extensions", "my-guard.ts"),
});
```

The file must export a default function: `export default function(pi: ExtensionAPI) { ... }`

### 4h. Footer segments

Add a status indicator to the TUI footer bar:

```typescript
pi.events.emit("flow:register-footer-segment", {
  id:       "my-connection",
  priority: 20,              // higher numbers render further right
  render:   () => isConnected() ? " ◉ connected" : " ◎ offline",
});
```

---

## 5. Unregistering content

For dynamic content registration (e.g., project-scoped agents loaded on demand):

```typescript
// Register on project open
pi.events.emit("flow:register-agents-dir", { dir: projectAgentsDir });

// Unregister on project close
pi.events.emit("flow:unregister-agents-dir", { dir: projectAgentsDir });
pi.events.emit("flow:unregister-flows-dir",  { dir: projectFlowsDir });
```

After unregistering a flows directory, the slash-commands for those flows are replaced with no-op handlers (they no longer do anything).

---

## 6. Observing flow execution

Your extension can listen to the full flow lifecycle for metrics, logging, or UI updates:

```typescript
export default function myExtension(pi: ExtensionAPI) {
  pi.events.on("flow:flow-started", (data: any) => {
    console.log(`Flow started: ${data.flowName}`);
  });

  pi.events.on("flow:agent-complete", (data: any) => {
    const { agentName, stepId, result } = data;
    recordMetrics(agentName, result.duration, result.tokens);
  });

  pi.events.on("flow:complete", (result: any) => {
    console.log(`Flow done in ${result.totalDuration}ms, ${result.stepCount} steps`);
  });
}
```

See [events-api.md](events-api.md) for the full list of observable events.

---

## 7. Using the public API directly

For programmatic flow execution (e.g., from a CI tool), import from `pi-flows`:

```typescript
import {
  discoverAll,
  resolvePackageRoot,
  spawnAgent,
  runFlow,
  parseAgentFile,
  parseFlowYamlFile,
} from "pi-flows/extensions/flow-engine/index.js";

// Discover agents and flows
const { agents, flows } = discoverAll(pkgRoot, projectRoot, extraAgentsDirs, extraFlowsDirs);

// Run a flow headlessly
const result = await runFlow({
  flow: flows.get("my-flow")!,
  task: "Do the thing",
  cwd: process.cwd(),
  getAgent: (name) => agents.get(name),
  askUser: async (question) => ({ answer: "yes" }),
});
```

See [public-api.md](public-api.md) for full API documentation.

---

## 8. Common pitfalls

| Problem | Fix |
|---------|-----|
| Agents not discovered | Check `dir` is an **absolute** path. Use `join(pkgRoot, "agents")`. |
| Flow name collision | Later `register-agents-dir` / `register-flows-dir` calls win. Use subfolders to namespace flows. |
| Tool not available to agents | Use `flow:register-tool`, not `pi.registerTool()`. The latter only registers in the main session. |
| Guard blocks `finish` | The guard automatically whitelists `finish`. Never block it. |
| Gate check is async | Gates must return synchronously. Cache the auth state; update it asynchronously in background. |
| Re-discovery not triggered | Call `flow:rediscover` or write files via `flow_agents` (op `write`) / `flow_write` (which auto-trigger re-discovery). |
