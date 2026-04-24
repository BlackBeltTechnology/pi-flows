# Shell Step Type — Design

**Date:** 2026-04-24  
**Status:** Approved

---

## Overview

Add a `shell` step type to pi-flows that executes arbitrary shell commands (bash scripts, npm/pnpm/yarn, make, etc.) directly within a flow — without needing a full AI agent. Shell steps support success/failure branching, configurable commands via a 3-layer config system, and a configurable timeout.

---

## New Step Type: `ShellStep`

```typescript
export interface ShellStep {
  stepType: "shell";
  id: string;
  command: string;           // Template string, e.g. "${{config.package_manager}} run build"
  timeout?: number;          // Seconds. Default: 1800 (30 min)
  config?: Record<string, string>;  // Per-step config overrides
  on_complete?: string;      // Route on exit code 0
  on_error?: string;         // Route on non-zero exit or timeout
}
```

Added to the `FlowStep` discriminated union in `types.ts`.

---

## Config System (3-layer resolution)

Config variables are referenced in `command` strings via `${{config.key}}` template syntax — consistent with existing `${{task}}`, `${{result.X.field}}` patterns.

Resolution order (highest priority wins):

1. **Per-step `config:`** — inline on the shell step itself
2. **Flow-level `config:`** — top-level block in the flow YAML
3. **Global `config:`** — `.pi/flows/config.yaml` in the project root

### `.pi/flows/config.yaml` (global)

```yaml
package_manager: pnpm
node_env: production
```

### Flow YAML example

```yaml
name: ci
description: Build, test, and deploy
config:
  package_manager: pnpm        # overrides global

steps:
  - id: build
    type: shell
    command: "${{config.package_manager}} run build"
    timeout: 300
    on_complete: test
    on_error: notify

  - id: test
    type: shell
    command: "${{config.package_manager}} run test"
    config:
      package_manager: yarn    # overrides flow-level for this step only
    on_complete: deploy
    on_error: notify

  - id: deploy
    type: shell
    command: "make deploy"
    on_complete: notify
    on_error: notify

  - id: notify
    agent: slack-notifier
    task: "Report result: ${{result.build.status}}, ${{result.test.status}}"
```

---

## Execution

### Process spawning

- Uses Node.js `child_process.spawn` (not `exec`) for real-time stdout/stderr streaming
- Shell: `sh -c "<command>"` — no configurable shell binary
- Working directory: always `cwd` (project root)
- Timeout: kills the process (`SIGTERM` → `SIGKILL`) and routes to `on_error`
- Default timeout: **1800 seconds (30 min)**

### `AgentResult` mapping

Shell steps reuse the existing `AgentResult` type so results flow seamlessly into downstream agent steps via template expressions.

| `AgentResult` field | Shell mapping |
|---|---|
| `success` | `exitCode === 0` |
| `output` | stdout (full) |
| `stderr` | stderr (full) |
| `exitCode` | process exit code |
| `result.status` | `"complete"` (exit 0) or `"error"` (non-zero / timeout) |
| `result.summary` | `"Exited with code 0"` or `"Timed out after 300s"` or `"Exited with code 1"` |
| `result.files` | `[]` (shell steps don't track files) |
| `result.artifacts` | `""` |

### Downstream access via template expressions

```yaml
- id: report
  agent: reporter
  task: "Build output: ${{result.build.output}}, exit: ${{result.build.status}}"
```

---

## Flow Execution Integration

### Segment classification

Shell steps are classified as **separator steps** in `splitIntoSegments()` (alongside `fork`, `conditional`, `agent-decision`, etc.). This means:

- They break DAG parallelism — agent steps before and after a shell step run in separate DAG segments
- They execute sequentially in the main flow loop via `executeStep()`
- They respect `on_complete` / `on_error` routing like all other separator steps

### New function: `executeShellStep()`

Added to `flow-execution.ts`. Handles:
1. Merge configs (global → flow → step)
2. Expand `${{config.key}}` and other template variables in `command`
3. Spawn process, stream stdout/stderr, enforce timeout
4. Emit `onAgentStarted` / `onAgentComplete` (using step `id` as agent name)
5. Store result in `ctx.results[stepId]` via `storeResult()`
6. Return `{ agentResult, nextStepId }` based on exit code

### `executeStep()` switch

```typescript
case "shell": return executeShellStep(step, ctx, options);
```

---

## Parser Changes

### `flow-parser-yaml.ts`

- `inferStepType()`: detects `type: shell` or infers from presence of `command:` field
- `parseShellStep()`: parses `command`, `timeout`, `config`, `on_complete`, `on_error`
- `parseFlowYamlString()`: reads top-level `config:` block and attaches to `FlowConfig`

### `types.ts`

- `ShellStep` interface added to `FlowStep` union
- `FlowConfig` gets optional `config?: Record<string, string>` field

### `flow-validate.ts`

- Validates shell steps: `command` required, `timeout` must be positive integer if present
- Warns if `on_error` is missing (non-fatal)

### `expandTemplateVariables()` in `execution.ts`

- New pattern: `${{config.key}}` — resolved against merged config at call time
- Config is passed into `TemplateContext` as a new optional `config` field

---

## Files to Change

| File | Change |
|---|---|
| `extensions/flow-engine/types.ts` | Add `ShellStep`, extend `FlowStep` union, add `config` to `FlowConfig`, add `config` to `TemplateContext` |
| `extensions/flow-engine/flow-parser-yaml.ts` | Parse `type: shell`, `config:` at flow level, `parseShellStep()` |
| `extensions/flow-engine/execution.ts` | Add `${{config.key}}` to `expandTemplateVariables()`, accept `config` in `TemplateContext` |
| `extensions/flow-engine/flow-execution.ts` | `executeShellStep()`, update `executeStep()` switch, load global config, pass merged config into template context |
| `extensions/flow-engine/tools/flow-validate.ts` | Validate shell steps |

---

## Documentation Updates

| File | Change |
|------|--------|
| `README.md` | Shell step example in "Writing Flows" section; `${{config.key}}` in template variables |
| `docs/flows.md` | Shell Step section (syntax, fields, config resolution, CI example); `${{config.key}}` in template variable table; `config:` in flow frontmatter |
| `docs/flow-authoring.md` | Shell step as step type #2; `config:` in top-level flow structure; `command` in infer table; `${{config.key}}` and `${{result.X.output}}` in template variables |

## Tests

No test infrastructure exists in the project (only `extensions/flow-dashboard/tests-card.ts` which is a type file, not a test runner). Tests are out of scope for this feature until a test framework is introduced.

---

## Out of Scope

- Configurable shell binary (always `sh -c`)
- File tracking for shell steps (no `result.files` population)
- Streaming shell output to TUI in real-time (output available after completion)
- Shell steps inside DAG segments (they are always separators)
- Test suite (no test framework in the project yet)
