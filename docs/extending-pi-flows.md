# Extending pi-flows

This guide explains how to build packages that build on top of pi-flows.

## Package.json Setup

To ensure compatibility, specify pi-flows and its dependencies as peer dependencies in your `package.json`.

```json
{
  "name": "my-custom-flows",
  "version": "1.0.0",
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "pi-flows": "*"
  },
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```

## Registration Patterns

Your extension can contribute new capabilities to pi-flows by emitting registration events during initialization.

### Agents, Flows, and Skills Directories

The most common way to extend pi-flows is by providing reusable agents and flows.

```typescript
export function init(app: PiApp) {
    const agentsDir = path.join(__dirname, '../agents');
    const flowsDir = path.join(__dirname, '../flows');
    const skillsDir = path.join(__dirname, '../skills');

    app.emit('flow:register-agent-dir', agentsDir);
    app.emit('flow:register-flow-dir', flowsDir);
    app.emit('flow:register-skill-dir', skillsDir);
}
```

### Dashboard Cards

You can customize how your agents are displayed in the TUI dashboard.

```typescript
import { Box } from 'blessed';

export function init(app: PiApp) {
    app.emit('flow:register-card', {
        agentId: 'my-special-agent',
        renderer: {
            getHeight: (data) => 5,
            render: (data) => {
                const box = Box({
                    content: `Status: ${data.status}\nOutput: ${data.output?.summary || 'N/A'}`,
                    style: { border: { fg: 'cyan' } }
                });
                return box;
            }
        }
    });
}
```

### Custom Condition Gates

Gates allow you to add custom logic for conditional flow steps.

```typescript
export function init(app: PiApp) {
    app.emit('flow:register-gate', {
        id: 'has-test-files',
        evaluate: async (context) => {
            // Context contains step outputs and inputs
            const files = context.inputs.files || [];
            return files.some(f => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
        }
    });
}
```

### Footer Segments

You can add custom information to the flow dashboard footer.

```typescript
export function init(app: PiApp) {
    app.emit('flow:register-footer-segment', {
        id: 'memory-usage',
        position: 'right',
        order: 10,
        render: () => {
            const usage = process.memoryUsage();
            return `RAM: ${Math.round(usage.rss / 1024 / 1024)}MB`;
        }
    });
}
```
