# Skills & Extensions Reference

## Skills

Skills are bundles of reference documentation that agents can query at runtime. Each skill is a directory containing an index file (`SKILL.md`) and topic-specific Markdown files.

### Skill Directory Structure

```
skills/
  <skill-name>/
    SKILL.md              # Index with frontmatter
    topic-a.md            # Reference document
    topic-b.md            # Reference document
```

### SKILL.md Format

```markdown
---
name: my-skill
description: What this skill provides
files:
  - topic-a.md
  - topic-b.md
---

# Skill Name

Overview text explaining when and how to use this skill.

## Available Reference Files

- **topic-a.md** — Description of contents
- **topic-b.md** — Description of contents
```

### Creating Skills for Your Domain

Skills provide domain-specific knowledge to agents without bloating their system prompts. The `SKILL.md` file is injected into the agent's prompt, while topic files are accessed on-demand via the `skill_read` tool.

**Best practices:**
- Keep `SKILL.md` concise — it's injected into every agent that declares the skill
- Put detailed reference material in topic files
- One topic per file, under 500 lines
- Include code examples in fenced blocks with language tags
- Use "Best Practices" sections at the end of each topic file

### Example: Frontend Docs Skill

```
skills/
  my-frontend-docs/
    SKILL.md
    hooks-and-customizations.md
    component-overrides.md
    state-management.md
    theme-customization.md
    testing-guide.md
```

**SKILL.md:**
```markdown
---
name: my-frontend-docs
description: Reference documentation for frontend development
files:
  - hooks-and-customizations.md
  - component-overrides.md
  - state-management.md
  - theme-customization.md
  - testing-guide.md
---

# Frontend Documentation

Reference docs for the frontend framework. Use `skill_read` to access detailed guides.

## Available Reference Files

- **hooks-and-customizations.md** — Hook types, registration patterns, best practices
- **component-overrides.md** — Override registry, component identifiers
- **state-management.md** — State patterns, data flow, context providers
- **theme-customization.md** — Theme configuration, component-level overrides
- **testing-guide.md** — Testing stack, component tests, API mocking
```

---

## Extensions

Extensions are TypeScript modules that hook into the pi-coding-agent lifecycle via the `ExtensionAPI`.

### Extension Registration

Extensions are declared in the package manifest:

```json
{
  "pi": {
    "extensions": ["./extensions/my-extension"]
  }
}
```

The module must export a default function:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Register commands, handlers, guards, etc.
}
```

### ExtensionAPI Capabilities

| Method | Purpose |
|--------|---------|
| `pi.registerCommand(name, handler)` | Register a `/command` |
| `pi.on(event, handler)` | Listen to lifecycle events |
| `pi.registerTool(name, handler)` | Register a custom tool |
| `pi.emit(event, data)` | Emit custom events |

### Example: Domain-Specific Extension

A typical domain package extension registers agents, flows, skills, custom tools, and guards:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function myDomainExtension(pi: ExtensionAPI) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // Register agents, flows, and skills
  pi.events?.emit("flow:register-agents-dir", { dir: join(pkgRoot, "agents") });
  pi.events?.emit("flow:register-flows-dir", { dir: join(pkgRoot, "flows") });
  pi.events?.emit("flow:register-skills-dir", { dir: join(pkgRoot, "skills") });

  // Register a custom command
  pi.registerCommand("my:status", {
    description: "Show domain status",
    handler: async (_args, ctx) => {
      // Implement status display
      ctx.ui.notify("Status: all good", "info");
    },
  });

  // Register a custom tool for agents
  pi.events?.emit("flow:register-tool", {
    name: "my_domain_tool",
    description: "Domain-specific tool for agents",
    schema: { /* TypeBox schema */ },
    handler: async (args: any) => {
      return { result: "tool output" };
    },
  });

  // Register a subagent guard for sandboxing
  pi.events?.emit("flow:register-guard-extension", {
    path: join(pkgRoot, "extensions", "my-guard.ts"),
  });
}
```

### Guard Extensions

Guard extensions are loaded into spawned subagent processes to enforce domain-specific sandboxing:

```typescript
// extensions/my-guard.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myGuard(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    const { tool, args } = event;
    
    // Block direct access to protected files
    if (tool === "write" && args.path?.match(/\.protected$/)) {
      return {
        block: true,
        reason: "Cannot modify .protected files directly. Use the domain tool instead.",
      };
    }
  });
}
```

### Utilities

Common utility patterns for extensions:

| Pattern | Purpose |
|---------|---------|
| Slugify | Convert descriptions to kebab-case identifiers |
| Registry | Track lifecycle state for domain entities |
| Context resolver | Map bare paths to physical paths |
| Lock management | Prevent concurrent operations |
