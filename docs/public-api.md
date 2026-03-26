# Public API

pi-flows exports types and functions from its flow-engine and flow-dashboard modules. These can be imported directly by dependent packages.

## Table of Contents

- [Import Paths](#import-paths)
- [Flow Engine Types](#flow-engine-types)
  - [AgentConfig](#agentconfig)
  - [FlowConfig](#flowconfig)
  - [FlowStep Types](#flowstep-types)
  - [AgentResult](#agentresult)
  - [FlowResult](#flowresult)
  - [TemplateContext](#templatecontext)
  - [ParsedResult](#parsedresult)
  - [ToolCallRecord](#toolcallrecord)
  - [SubagentEvent Types](#subagentevent-types)
  - [Supporting Types](#supporting-types)
- [Flow Dashboard Types](#flow-dashboard-types)
  - [WorkflowDefinition](#workflowdefinition)
  - [AgentCardRenderer](#agentcardrenderer)
  - [CardData](#carddata)
- [Exported Functions](#exported-functions)
  - [Agent & Flow Parsing](#agent--flow-parsing)
  - [Template Expansion](#template-expansion)
  - [Execution](#execution)
  - [Discovery](#discovery)
  - [Model Resolution](#model-resolution)
  - [Result Parsing](#result-parsing)
- [Guard Extension API](#guard-extension-api)
  - [createGuardExtension](#createguardextension)
  - [GuardOptions](#guardoptions)
- [SDK Integration Details](#sdk-integration-details)
  - [In-Process Session Model](#in-process-session-model)
  - [Capturing Session Context](#capturing-session-context)
  - [Tool Factory Map](#tool-factory-map)

---

## Import Paths

pi-flows is loaded by pi via [jiti](https://github.com/unjs/jiti) (TypeScript-to-JS transpilation at runtime). Import from the extension module paths relative to your pi-flows dependency:

```typescript
// Types from flow-engine
import type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
  TemplateContext,
} from "pi-flows/extensions/flow-engine/types.js";

// Functions from flow-engine
import { spawnAgent, expandTemplateVariables } from "pi-flows/extensions/flow-engine/execution.js";
import { runFlow } from "pi-flows/extensions/flow-engine/flow-execution.js";
import { discoverAll, resolvePackageRoot } from "pi-flows/extensions/flow-engine/discovery.js";
import { resolveModel } from "pi-flows/extensions/flow-engine/model-roles.js";
import { parseResult, hasArtifactElement } from "pi-flows/extensions/flow-engine/result-parser.js";
import { parseAgentFile, parseAgentString } from "pi-flows/extensions/flow-engine/agent-parser.js";
import { parseFlowFile, parseFlowString } from "pi-flows/extensions/flow-engine/flow-parser.js";

// Guard factory (for building custom guard extensions)
import { createGuardExtension } from "pi-flows/extensions/flow-engine/guard.js";
import type { GuardOptions } from "pi-flows/extensions/flow-engine/guard.js";

// Types from flow-dashboard
import type {
  WorkflowDefinition,
  WorkflowStage,
  AgentCardRenderer,
  CardStatus,
  CardData,
} from "pi-flows/extensions/flow-dashboard/types.js";
```

Alternatively, the flow-engine index re-exports the most commonly used types and functions:

```typescript
import type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
  TemplateContext,
  SubagentEvent,
  ArchitectMeta,
  CardConfig,
} from "pi-flows/extensions/flow-engine/index.js";

import {
  spawnAgent,
  expandTemplateVariables,
  runFlow,
  discoverAll,
  resolvePackageRoot,
  resolveModel,
  parseResult,
  hasArtifactElement,
  parseAgentFile,
  parseAgentString,
  parseFlowFile,
  parseFlowString,
  extractAgentNames,
} from "pi-flows/extensions/flow-engine/index.js";
```

> **Note:** pi-flows uses a single extension entry point, so all internal modules share one jiti module graph and module-level state works naturally. External packages should use the event-based APIs (e.g., `flow:get-agents`, `flow:register-card`) rather than importing pi-flows modules directly at runtime. Type-only imports (`import type`) are fine since they're erased at compile time.

---

## Flow Engine Types

### AgentConfig

Parsed from agent `.md` frontmatter. Represents a fully resolved agent definition.

```typescript
interface AgentConfig {
  name: string;                 // Unique agent identifier
  description: string;          // What this agent does
  model: string;                // Model role (@coding) or direct model ID
  thinking?: string;            // off, minimal, low, medium, high, xhigh
  tools: string[];              // Declared tools (e.g., ["read", "write", "bash"])
  skills?: string[];            // Skill names for prompt injection
  context?: string[];           // File paths to inject as context
  inputs?: string[];            // Declared input names (contract for flow wiring)
  systemPrompt: string;         // Body of the .md file (template with {task}, {input.*})
  output?: string;              // Default output filename
  interactive?: boolean;        // Whether agent interacts with user
  source: string;               // File path where this agent was discovered
  access?: AccessRules;         // Sandboxing rules
  card?: CardConfig;            // Dashboard card configuration
  architect?: ArchitectMeta;    // Flow Architect metadata
}
```

### FlowConfig

Parsed from `.flow.md` frontmatter and step sections.

```typescript
interface FlowConfig {
  name: string;                 // Flow identifier (becomes the slash command)
  description: string;          // What this flow does
  max_concurrent?: number;      // Max parallel agents
  steps: FlowStep[];            // Ordered step definitions
  source: string;               // File path where discovered
}
```

### FlowStep Types

Discriminated union on `stepType`:

```typescript
type FlowStep =
  | AgentStep
  | ForkStep
  | ConditionalStep
  | AgentDecisionStep
  | AgentLoopDecisionStep
  | FlowRefStep;

interface AgentStep {
  stepType: "agent";
  id: string;
  agent: string;
  task?: string;
  model?: string;
  output?: string;
  reads?: string[];
  inputs?: Record<string, string>;
  blockedBy?: string[];
  on_complete?: string;
  on_error?: string;
}

interface ForkStep {
  stepType: "fork";
  id: string;
  question: string;
  options: string[];
  branches: Record<string, string>;
  allowNotes?: boolean;
  allowCustom?: boolean;    // @deprecated — use allowNotes instead
  multiSelect?: boolean;
  decisionAgent?: string;   // @deprecated — use agent field instead
  agent?: string;           // Agent to use when auto-deciding (autonomous mode)
  task?: string;            // Context/task for the agent when auto-deciding
}

interface ConditionalStep {
  stepType: "conditional";
  id: string;
  check: string;
  present: string;
  absent: string;
}

interface AgentDecisionStep {
  stepType: "agent-decision";
  id: string;
  agent: string;
  task: string;
  branches: Record<string, string>;
}

interface AgentLoopDecisionStep {
  stepType: "agent-loop-decision";
  id: string;
  agent: string;
  task: string;
  loop_target: string;
  exit_target: string;
  max_iterations: number;
}

interface FlowRefStep {
  stepType: "flow-ref";
  id: string;
  path: string;
  on_complete?: string;
  on_error?: string;
}
```

### AgentResult

Result from a single agent execution (in-process SDK session).

```typescript
interface AgentResult {
  success: boolean;             // Whether the agent completed successfully
  output: string;               // Raw full output text (last assistant message)
  stderr: string;               // Session diagnostics (API errors, etc.)
  exitCode: number | null;      // Process exit code
  result: ParsedResult;         // Parsed from <result> envelope
  toolCalls: ToolCallRecord[];  // All tool calls made
  duration: number;             // Execution time in ms
  tokens: {
    input: number;
    output: number;
  };
  finishParams?: Record<string, any>;  // Raw finish tool call args
}
```

### FlowResult

Complete result from a flow execution. Emitted with `flow:complete`.

```typescript
interface FlowResult {
  lastResult: AgentResult;      // Result from the last executed step
  results: Record<string, {
    fullOutput: string;
    status: string;             // "complete" | "error" | "blocked"
    summary: string;
    artifacts: string;
    files: string;
  }>;
  forks: Record<string, {
    answer: string;
    notes?: string;
  }>;
  flowName: string;
  stepCount: number;
  totalDuration: number;        // Wall-clock ms for entire flow
  status?: "success" | "error" | "aborted"; // Overall flow outcome
}
```

### TemplateContext

Context object for template variable expansion in flow steps.

```typescript
interface TemplateContext {
  task: string;
  inputs: Record<string, string>;
  results: Record<string, {
    fullOutput: string;
    status: string;
    summary: string;
    artifacts: string;
    files: string;
  }>;
  forks: Record<string, {
    answer: string;
    notes?: string;
  }>;
  loopCounters?: Record<string, number>;
  loopMaxIterations?: Record<string, number>;
}
```

### ParsedResult

Parsed from the `<result>` XML envelope that agents produce via the `finish` tool.

```typescript
interface ParsedResult {
  status: "complete" | "error" | "blocked" | "unknown";
  files: ResultFile[];
  artifacts: string;            // Raw XML string of <artifacts> block
  summary: string;
}

interface ResultFile {
  path: string;
  action: "created" | "modified" | "read";
}
```

### ToolCallRecord

Record of a single tool call made during agent execution.

```typescript
interface ToolCallRecord {
  toolName: string;
  input: any;
  output: any;
  duration: number;             // ms
  isError: boolean;
}
```

### SubagentEvent Types

Event types for tracking agent session activity during flow execution.

```typescript
type SubagentEventType = "started" | "complete" | "tool_call" | "tool_result";

interface SubagentEvent {
  type: SubagentEventType;
  agentName: string;
  flowName?: string;
  stepId?: string;
  timestamp: number;
  data: any;
}

interface SubagentStartedEvent extends SubagentEvent {
  type: "started";
  data: { task: string; model: string };
}

interface SubagentCompleteEvent extends SubagentEvent {
  type: "complete";
  data: AgentResult;
}

interface SubagentToolCallEvent extends SubagentEvent {
  type: "tool_call";
  data: { toolName: string; input: any };
}

interface SubagentToolResultEvent extends SubagentEvent {
  type: "tool_result";
  data: { toolName: string; output: any; isError: boolean };
}
```

### Supporting Types

```typescript
interface CardConfig {
  type?: string;
  label?: string;
  metric?: string;
  role?: string;
}

interface ArchitectMeta {
  use_when?: string;
  produces?: string;
  depends_on?: string;
  domain?: string;
}

interface AccessRules {
  read?: string[];              // Glob patterns for allowed read paths
  write?: string[];             // Glob patterns for allowed write paths
  bash?: {
    deny: string[];             // Command patterns to block
  };
}
```

---

## Flow Dashboard Types

### WorkflowDefinition

Multi-stage pipeline definition for breadcrumb navigation.

```typescript
interface WorkflowDefinition {
  id: string;
  stages: WorkflowStage[];
}

interface WorkflowStage {
  name: string;
  flows: string[];
  detailFn?: (ctx: any) => string;
}
```

### AgentCardRenderer

Interface for custom dashboard card metric renderers.

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;
}
```

### CardData

Internal tracking state for agent cards on the dashboard.

```typescript
type CardStatus = "pending" | "running" | "complete" | "error";

interface CardData {
  agentName: string;
  status: CardStatus;
  stepId?: string;
  startTime?: number;
  endTime?: number;
  renderer: AgentCardRenderer;
  result?: AgentResult;
}
```

---

## Exported Functions

### Agent & Flow Parsing

#### parseAgentFile

Parse an agent definition from a `.md` file on disk.

```typescript
function parseAgentFile(filePath: string): AgentConfig
```

#### parseAgentString

Parse an agent definition from a string. `source` is recorded on the returned config for diagnostics.

```typescript
function parseAgentString(content: string, source: string): AgentConfig
```

#### parseFlowFile

Parse a `.flow.md` file from disk.

```typescript
function parseFlowFile(filePath: string): FlowConfig
```

#### parseFlowString

Parse a `.flow.md` string directly.

```typescript
function parseFlowString(content: string, source: string): FlowConfig
```

#### extractAgentNames

Collect all agent names referenced by a flow (from agent steps).

```typescript
function extractAgentNames(flow: FlowConfig): string[]
```

### Template Expansion

#### expandTemplateVariables

Expand template variables (`{task}`, `{result.*}`, `{input.*}`, etc.) in a string using the provided context.

```typescript
function expandTemplateVariables(template: string, ctx: TemplateContext): string
```

### Execution

#### spawnAgent

Execute a single agent as an in-process SDK session. Returns the full `AgentResult` including output, tool calls, tokens, and parsed result.

Agents no longer run as separate subprocesses — they run as in-process `createAgentSession()` calls from the pi-coding-agent SDK. The `authStorage` and `modelRegistry` needed to make model API calls are captured from the main session's `session_start` event (see [Capturing Session Context](#capturing-session-context)).

```typescript
import type { AuthStorage, ModelRegistry, ExtensionFactory } from "@mariozechner/pi-coding-agent";

interface SpawnOptions {
  agent: AgentConfig;
  task: string;
  templateContext: TemplateContext;
  skillContents?: Map<string, string>;      // Pre-loaded skill content to prepend to prompt
  contextFileContents?: string[];           // Pre-loaded context file strings
  getModelRole?: (role: string) => string | undefined;
  cwd: string;
  authStorage?: AuthStorage;               // From session_start capture (required for model calls)
  modelRegistry?: ModelRegistry;           // From session_start capture (required for model lookup)
  extraGuardFactories?: ExtensionFactory[]; // Additional guard factories beyond the built-in one
  extraCustomTools?: any[];                 // Extra tool definitions passed as customTools to the session
  onToolCall?: (toolName: string, input: any) => void;
  onToolResult?: (toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (text: string) => void;
  onThinkingText?: (text: string) => void;
  onExtensionUIRequest?: (request: any, respond: (response: any) => void) => void;
  decisionBranches?: string[];              // Branch names for agent-decision steps
  signal?: AbortSignal;
}

function spawnAgent(options: SpawnOptions): Promise<AgentResult>
```

#### runFlow

Execute a complete flow with all its steps, handling DAG scheduling, forks, conditionals, decisions, loops, and sub-flows.

```typescript
interface FlowRunOptions {
  flow: FlowConfig;
  task: string;
  cwd: string;
  authStorage?: any;                   // From session_start capture
  modelRegistry?: any;                 // From session_start capture
  extraGuardFactories?: any[];         // Additional ExtensionFactory instances
  getModelRole?: (role: string) => string | undefined;
  getAgent: (name: string) => AgentConfig | undefined;
  getSkillContent?: (name: string) => string | undefined;
  getContextFiles?: (agent: AgentConfig) => string[];
  askUser: (question: string, type: string, options?: string[], extra?: any) =>
    Promise<{ answer: string; notes?: string }>;
  onAgentStarted?: (agentName: string, stepId: string) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult) => void;
  onToolCall?: (agentName: string, toolName: string, input: any) => void;
  onToolResult?: (agentName: string, toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (agentName: string, text: string) => void;
  onThinkingText?: (agentName: string, text: string) => void;
  onExtensionUIRequest?: (agentName: string, request: any, respond: (response: any) => void) => void;
  onLoopIteration?: (stepId: string, iteration: number, maxIterations: number) => void;
  isAutonomous?: () => boolean;        // If true, fork steps auto-decide via agent
  onAutoDecision?: (forkId: string, agentName: string, chosenBranch: string, targetStepId: string) => void;
  signal?: AbortSignal;
}

function runFlow(options: FlowRunOptions): Promise<FlowResult>
```

### Discovery

#### discoverAll

Discover all agents and flows from multiple tiers: extra package directories → pi-flows package → project-local (`.pi/flows/`).

```typescript
interface DiscoveryResult {
  agents: Map<string, AgentConfig>;
  flows: Map<string, FlowConfig>;
}

function discoverAll(
  packageRoot: string,
  projectRoot: string,
  extraAgentsDirs?: string[],
  extraFlowsDirs?: string[],
): DiscoveryResult
```

#### resolvePackageRoot

Resolve a package root directory from `import.meta.url`. Goes up two levels from the calling file's directory (e.g., `extensions/my-ext/index.ts` → `my-pkg/`).

```typescript
function resolvePackageRoot(importMetaUrl: string): string

// Usage in your extension:
const pkgRoot = resolvePackageRoot(import.meta.url);
```

### Model Resolution

#### resolveModel

Resolve a model reference string into a concrete model ID and optional thinking level.

Supports three formats:
1. **Role alias** — `@planning`, `@coding` (resolved via callback)
2. **Model ID with thinking suffix** — `claude-sonnet-4-20250514:high`
3. **Plain model ID** — `claude-sonnet-4-20250514`

```typescript
function resolveModel(
  modelRef: string,
  thinking?: string,
  getModelRole?: (role: string) => string | undefined,
): { modelId: string; thinking?: string }
```

### Result Parsing

#### parseResult

Parse a `<result>` XML envelope from raw agent output. If no `<result>` block is found, returns a fallback with `status: "unknown"`.

```typescript
function parseResult(output: string): ParsedResult
```

#### hasArtifactElement

Check whether a specific element exists inside a raw `<artifacts>` XML string. Uses dot-notation (e.g., `"artifacts.gaps"` checks for a `<gaps` tag).

```typescript
function hasArtifactElement(artifacts: string, elementPath: string): boolean
```

---

## Guard Extension API

The guard extension is the sandboxing layer injected into every agent session. It enforces tool whitelists, access rules, and the `finish` requirement.

### createGuardExtension

Creates an `ExtensionFactory` that sandboxes an agent session. Used internally by `spawnAgent()` but also exported for advanced use cases where you need to spawn agents directly outside the flow engine.

```typescript
import { createGuardExtension } from "pi-flows/extensions/flow-engine/guard.js";
import type { GuardOptions } from "pi-flows/extensions/flow-engine/guard.js";

const factory = createGuardExtension({
  allowedTools: ["read", "grep", "finish"],
  requireFinish: true,
  accessRules: {
    read: ["src/**", "docs/**"],
    write: ["src/**"],
    bash: { deny: ["rm -rf", "curl"] },
  },
});
```

The returned `ExtensionFactory` is a `(pi: ExtensionAPI) => void` function that wires the guard logic into the session via `pi.on("tool_call", ...)` and `pi.registerTool(...)`.

### GuardOptions

```typescript
interface GuardOptions {
  allowedTools?: string[];      // Whitelist of allowed tool names (finish always implicitly allowed)
  requireFinish?: boolean;      // Register the finish tool and block post-finish calls
  accessRules?: AccessRules;    // File read/write/bash path restrictions
  decisionBranches?: string[];  // Add branch parameter to finish for agent-decision steps
  allowAskUser?: boolean;       // Allow ask_user tool calls (default: false — agents must decide autonomously)
}
```

When `decisionBranches` is set, the `finish` tool gains a required `branch` parameter constrained to one of the listed values. This is how `agent-decision` and `agent-loop-decision` steps enforce routing.

---

## SDK Integration Details

This section documents how pi-flows uses the pi-coding-agent SDK internally to run agents as in-process sessions. This is relevant if you are calling `spawnAgent()` or `runFlow()` directly from your own code.

### In-Process Session Model

Agents no longer run as separate `pi` subprocesses. Instead, `spawnAgent()` creates an in-process SDK session using `createAgentSession()` from `@mariozechner/pi-coding-agent`:

```typescript
import {
  createAgentSession,
  SessionManager,
  createExtensionRuntime,
  createEventBus,
} from "@mariozechner/pi-coding-agent";

// Internally, spawnAgent() does:
const { session } = await createAgentSession({
  model,                          // Resolved Model object (from modelRegistry or getModel)
  thinkingLevel: thinking,        // "high" | "medium" | "low" | "off" | undefined
  tools,                          // SDK tool instances from TOOL_FACTORIES
  customTools: extraCustomTools,  // Extra tool definitions (architect tools, etc.)
  resourceLoader,                 // Provides guard extensions + appended system prompt
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  cwd,
});

await session.bindExtensions({ uiContext });
await session.prompt(userMessage, { expandPromptTemplates: false });
```

The guard extensions are passed via a `ResourceLoader` object:

```typescript
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions, errors: [], runtime }),
  getAppendSystemPrompt: () => [capturedSystemPrompt],
  // ... other no-op methods
};
```

> **Why `getAppendSystemPrompt` and not `getSystemPrompt`?** Using `getSystemPrompt` would replace the SDK's default system prompt (which includes tool descriptions and guidelines). `getAppendSystemPrompt` appends the agent-specific system prompt *after* the SDK builds its default prompt, so the agent gets both tool descriptions and its custom instructions.

Guard factories (`ExtensionFactory[]`) are converted to Extension objects via an internal `buildExtensionFromFactory()` helper, which constructs a minimal `ExtensionAPI` shim and runs the factory against it. This is necessary because the SDK's `loadExtensionFromFactory` is not exported from the top-level package path.

### Capturing Session Context

`spawnAgent()` requires `authStorage` and `modelRegistry` to resolve and call models. These are available from the pi session context, captured in the main session's `activate()` function:

```typescript
export default function activate(pi: ExtensionAPI) {
  let authStorage: any;
  let modelRegistry: any;

  // Capture auth + registry from the live session
  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.modelRegistry) {
      modelRegistry = ctx.modelRegistry;
      authStorage = (ctx.modelRegistry as any).authStorage;
    }
  });

  // Pass them along when spawning agents directly:
  const result = await spawnAgent({
    agent,
    task,
    templateContext,
    cwd: process.cwd(),
    authStorage,
    modelRegistry,
    // ...
  });
}
```

Alternatively, use the `flow:get-spawn-context` query event to retrieve the captured values from pi-flows itself (useful when the values are captured by pi-flows but your extension needs them):

```typescript
const spawnCtx: any = {};
pi.events.emit("flow:get-spawn-context", spawnCtx);
const { authStorage, modelRegistry, extraGuardFactories } = spawnCtx;
```

See [events-api.md](events-api.md#flowget-spawn-context) for details on this query event.

### Tool Factory Map

`spawnAgent()` instantiates the agent's declared tools by mapping tool names to SDK factory functions:

```typescript
const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
  read:  createReadTool,
  bash:  createBashTool,
  edit:  createEditTool,
  write: createWriteTool,
  grep:  createGrepTool,
  find:  createFindTool,
  ls:    createLsTool,
};
```

Any tool name in the agent's `tools:` frontmatter that is not in this map is silently ignored (e.g., `skill_read`, `ask_user` — those are provided via extensions, not SDK tool factories).

The `finish` tool is not in the factory map. It is injected exclusively by the guard extension (`createGuardExtension({ requireFinish: true })`), which registers it as a proper tool with TypeBox schema validation.
