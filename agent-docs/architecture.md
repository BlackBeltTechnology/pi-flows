# pi-flows Architecture

> Internal design reference for pi-flows developers and package authors. User docs: [README.md](../README.md).

## System Overview

pi-flows: multi-agent workflow orchestration engine for [pi](https://github.com/badlogic/pi-mono). Discovers and loads packages at runtime from `package.json` manifests tagged with `pi-package` keyword. Provides DAG-based execution engine coordinating multiple AI agents.

Engine organized as cooperating sub-extensions activated through single entry point (`extensions/index.ts`). Shares one module graph and consistent state.

## Component Stack

```
┌─────────────────────────────────────────────────────────────┐
│                         User (TUI)                          │
│               /flow commands, interactive prompts            │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                      pi-flows Engine                        │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Flow Executor│  │ Agent Spawner│  │ Agent Dashboard   │  │
│  │              │  │              │  │ (TUI widget)      │  │
│  │ - DAG walk   │  │ - Process    │  │ - Card grid       │  │
│  │ - Branching  │  │   isolation  │  │ - Live metrics    │  │
│  │ - Loops      │  │ - Tool guard │  │ - Status tracking │  │
│  │ - Sub-flows  │  │ - Env inject │  │                   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   Package Loader                     │   │
│  │  - Discovers pi-package dependencies                 │   │
│  │  - Loads extensions, skills, agents, flows           │   │
│  │  - Resolves namespaced flow commands (pkg:flow)      │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
    ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
    │ pkg-a   │         │ pkg-b   │         │ (other) │
    │         │         │         │         │         │
    │ agents/ │         │ agents/ │         │ agents/ │
    │ flows/  │         │ flows/  │         │ flows/  │
    │ skills/ │         │ skills/ │         │ skills/ │
    │ ext/    │         │         │         │ ext/    │
    └─────────┘         └─────────┘         └─────────┘
```

## Package Discovery

pi-flows engine discovers packages via npm dependency graph:

1. Scans `node_modules/` for packages with `"pi-package"` in `keywords`
2. Reads `"pi"` manifest from each package's `package.json`
3. Registers extensions, skills, prompts, themes from declared paths
4. Loads agents from `agents/` directories
5. Loads flows from `flows/<namespace>/` directories

```json
{
  "name": "my-domain-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/my-ext"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

## Agent Isolation Model

Each agent runs as in-process isolated session with controlled capabilities:

```
┌──────────────────────────────────────────────────┐
│ Parent Process (pi-flows engine)                 │
│                                                  │
│  spawnAgent(agentDef, task, inputs)              │
│    │                                             │
│    ├── Serialize AGENT_ALLOWED_TOOLS → env       │
│    ├── Inject context files                      │
│    ├── Wire inputs from upstream results         │
│    └── Create agent session                       │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Agent Session (isolated)                      │  │
│  │                                            │  │
│  │  ┌─────────┐  ┌──────────┐                │  │
│  │  │ Guard   │  │ Agent    │                │  │
│  │  │         │  │ Prompt   │                │  │
│  │  │ - Tool  │  │ (from    │                │  │
│  │  │   allow │  │  .md)    │                │  │
│  │  │ - File  │  │          │                │  │
│  │  │   access│  │ ${{task}}│                │  │
│  │  │ - Bash  │  │ ${{input │                │  │
│  │  │   deny  │  │    .x}}  │                │  │
│  │  └─────────┘  └──────────┘                │  │
│  │                                            │  │
│  │  → Produces <result> on finish             │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Guard Layers

1. **Tool scoping** — `AGENT_ALLOWED_TOOLS` env var parsed into Set. Only declared tools + `finish` permitted.
2. **File access** — `access.read` and `access.write` glob patterns control filesystem ops.
3. **Bash deny list** — `access.bash.deny` patterns block specific shell commands.
4. **Agent extensions** — domain packages register additional extensions (guards, provider middleware, custom tools) into spawned agent sessions via `flow:register-agent-extension`.

## Flow Execution Model

Flow executor walks DAG of steps, manages parallelism and control flow:

### DAG Segment Execution

```
1. Initialize: completed = {}, running = {}, results = {}
2. Loop:
   a. Find unblocked steps: blockedBy ⊆ completed
   b. Filter by activeSteps (if branch exclusivity applies)
   c. Limit by max_concurrent
   d. Spawn agent processes for unblocked steps
   e. Wait for any completion
   f. Store result, add to completed set
   g. If all steps completed or error → exit loop
```

### Control Flow Primitives

**Fork (user decision):**
```
Fork step → present options to user → user selects → route to branch step(s)
                                                   → skip non-selected branches
```

**Conditional (automatic routing):**
```
Conditional step → check ctx.results[stepId][field]
                → non-empty? → route to "present" target
                → empty?     → route to "absent" target
```

**Agent Loop Decision:**
```
Decision agent → evaluates result → "loop" → jump to loop_target
                                  → "exit" → jump to exit_target
                                  (max_iterations safety limit)
```

**Flow Reference (sub-flow):**
```
flow-ref step → resolve path (supports globs) → execute sub-flow
             → merge sub-flow results into parent context
             → continue to on_complete target
```

### Result Propagation

Results flow through DAG via interpolation:

```
Step A produces:
  { summary: "...", artifacts: "...", files: [...] }

Step B references:
  task: "Use this: ${{result.step-a.summary}}"
  inputs:
    data: "${{result.step-a.artifacts}}"

Sub-flow results are flat-merged:
  flow-ref runs sub-flow with steps [x, y, z]
  → parent gets: results["x"], results["y"], results["z"]
  → also: results["flow-ref-step-id"] = last agent result
```

## Sub-Extension Activation Order

Sub-extensions load through single entry point (`extensions/index.ts`). Share one `jiti` module graph. Eliminates module identity issues from dynamic imports creating separate instances. Activation order:

```
1. provider-register  — Model roles (@coding, @planning, etc.) and provider management
2. file-tracker       — Tracks file edits/writes in the main session for footer stats
3. flow-engine        — Discovery, DAG execution, agent spawning, tool registration
4. flow-dashboard     — TUI card grid, navigation, workflow breadcrumbs
5. flow-summary       — Post-flow summary widget with expandable step results
6. flow-context       — #flows: inline reference and flow_results tool for main session
7. flow-workspace     — /flows command: create, edit, delete, and Flow Architect
8. flow-footer        — Footer segments: provider, git, file stats, context usage
```

## Extension Lifecycle

Extensions hook into pi-coding-agent lifecycle:

```
1. Package loaded (npm dependency graph scan for "pi-package" keyword)
2. Extension module imported via jiti
3. default export function called with ExtensionAPI
4. Extension registers:
   - Commands (pi.registerCommand)
   - Event handlers (pi.on / pi.events.on)
   - Tools (pi.registerTool)
   - Flow events (pi.events.emit "flow:register-*")
5. session_start fires:
   - Session auth/model storage captured
   - TUI adapter wired (if ctx.hasUI)
6. Events fire during agent execution:
   - "tool_call" → guard can block
   - flow:subagent-tool-call → observation
   - flow:subagent-tool-result → observation
7. Flow completes:
   - flow:complete → FlowResult emitted
   - Summary widget rendered
8. Cleanup on session end
```

## FlowManager Architecture

`FlowManager` class: central orchestration component. Adapter pattern decouples execution logic from UI:

```
┌──────────────────────────────────────────────────┐
│ FlowManager                                      │
│                                                  │
│  ┌─────────────────┐  ┌───────────────────────┐  │
│  │ FlowIOAdapter   │  │ FlowObserver[]        │  │
│  │ (pluggable)     │  │ (pluggable)           │  │
│  │                 │  │                       │  │
│  │ - askUser()     │  │ - onFlowStart()       │  │
│  │ - notify()      │  │ - onAgentStarted()    │  │
│  │ - selectFlow()  │  │ - onAgentComplete()   │  │
│  └─────────────────┘  │ - onFlowComplete()    │  │
│                       │ - onToolCall/Result()  │  │
│                       └───────────────────────┘  │
│                                                  │
│  Adapters:              Observers:               │
│  - TuiFlowIOAdapter     - TuiFlowObserver        │
│  - HeadlessFlowIOAdapter- EventEmitObserver       │
└──────────────────────────────────────────────────┘
```

At startup: `HeadlessFlowIOAdapter` wired. On `session_start` (if `ctx.hasUI`): upgrades to `TuiFlowIOAdapter`, adds `TuiFlowObserver`.
