# Public API

Exported types and functions from pi-flows. Import these when you need programmatic access to the flow engine, typed access to pi-flows data structures, or want to build utilities that work with agent and flow configurations.

---

## Import Paths

pi-flows exports its public API through the flow-engine extension module:

```typescript
// Core types and functions
import type {
  AgentConfig, FlowConfig, FlowResult, AgentResult,
  FlowStep, AgentStep, ForkStep, TemplateContext,
} from "pi-flows/extensions/flow-engine/index.js";

import {
  spawnAgent, runFlow, discoverAll, parseAgentFile,
  parseFlowYamlFile, resolvePackageRoot, expandTemplateVariables,
} from "pi-flows/extensions/flow-engine/index.js";

// Dashboard types
import type {
  WorkflowDefinition, WorkflowStage, AgentCardRenderer,
  CardData, CardStatus,
} from "pi-flows/extensions/flow-dashboard/index.js";
```

> **Prefer events over direct imports.** The event-based API ([events-api.md](events-api.md)) is the stable, recommended extension surface. Direct imports are appropriate for utilities, type checking, and programmatic flow execution outside the normal pi lifecycle.

---

## Core Types

### `AgentConfig`

Represents a parsed agent definition from a `.md` file.

```typescript
interface AgentConfig {
  name: string;
  description: string;
  model: string;           // "@coding", "@planning", or explicit model ID
  thinking?: string;       // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  tools: string[];         // e.g., ["read", "write", "edit", "bash"]
  skills?: string[];       // e.g., ["judo-backend-docs"]
  context?: string[];      // File paths injected as read-only context
  inputs?: string[];       // Declared input names (contract for flow wiring)
  systemPrompt: string;    // The body of the .md file (prompt template)
  output?: string;         // Default output filename
  interactive?: boolean;
  source: string;          // File path where this agent was discovered
  access?: AccessRules;
  card?: CardConfig;
  architect?: ArchitectMeta;
}
```

---

### `AccessRules`

```typescript
interface AccessRules {
  read?: string[];    // Glob patterns for allowed read paths
  write?: string[];   // Glob patterns for allowed write paths
  bash?: {
    deny: string[];   // Command patterns to block
  };
}
```

---

### `CardConfig`

```typescript
interface CardConfig {
  type?: string;    // Legacy type field
  label?: string;   // Display label on the dashboard card
  metric?: string;  // Metric renderer name (matches a registered AgentCardRenderer)
}
```

---

### `ArchitectMeta`

```typescript
interface ArchitectMeta {
  use_when?: string;    // When to use this agent
  produces?: string;    // What the agent outputs
  depends_on?: string;  // What it needs as input
  domain?: string;      // Agent's domain
}
```

---

### `FlowConfig`

Represents a parsed flow definition from a `.yaml` file.

```typescript
interface FlowConfig {
  name: string;
  description: string;
  max_concurrent?: number;
  task_required?: boolean;
  task_prompt?: string;
  steps: FlowStep[];
  source: string;   // File path where this flow was discovered
}
```

---

### `FlowStep`

Discriminated union of all step types:

```typescript
type FlowStep =
  | AgentStep
  | ForkStep
  | ConditionalStep
  | AgentDecisionStep
  | AgentLoopDecisionStep
  | FlowRefStep;
```

#### `AgentStep`

```typescript
interface AgentStep {
  stepType: "agent";
  id: string;
  agent: string;
  task?: string;
  model?: string;
  output?: string;
  reads?: string[];
  inputs?: Record<string, string>;   // name → template expression
  blockedBy?: string[];
  on_complete?: string;
  on_error?: string;
}
```

#### `ForkStep`

```typescript
interface ForkStep {
  stepType: "fork";
  id: string;
  question: string;
  options: string[];
  branches: Record<string, string>;  // option → step ID
  allowNotes?: boolean;
  allowCustom?: boolean;
  multiSelect?: boolean;
  agent?: string;                    // Agent for autonomous mode
  task?: string;                     // Task for autonomous agent
}
```

#### `ConditionalStep`

```typescript
interface ConditionalStep {
  stepType: "conditional";
  id: string;
  check: string;    // "stepId" or "stepId.field"
  present: string;  // Step ID if non-empty
  absent: string;   // Step ID if empty
}
```

#### `AgentDecisionStep`

```typescript
interface AgentDecisionStep {
  stepType: "agent-decision";
  id: string;
  agent: string;
  task: string;
  branches: Record<string, string>;  // branch name → step ID
}
```

#### `AgentLoopDecisionStep`

```typescript
interface AgentLoopDecisionStep {
  stepType: "agent-loop-decision";
  id: string;
  agent: string;
  task: string;
  loop_target: string;
  exit_target: string;
  max_iterations: number;
}
```

#### `FlowRefStep`

```typescript
interface FlowRefStep {
  stepType: "flow-ref";
  id: string;
  path: string;        // Path to the sub-flow file
  on_complete?: string;
  on_error?: string;
}
```

---

### `FlowResult`

The return value of `runFlow()` and the data payload of the `flow:complete` event.

```typescript
interface FlowResult {
  flowName: string;
  status?: "success" | "error" | "aborted";
  stepCount: number;
  totalDuration: number;  // Wall-clock time in milliseconds

  results: Record<string, {
    fullOutput: string;   // Raw agent output text
    status: string;       // "complete" | "error" | "blocked"
    summary: string;      // From finish(summary:)
    artifacts: string;    // Raw XML from <artifacts>
    files: string;        // Human-readable file list
  }>;

  forks: Record<string, {
    answer: string;
    notes?: string;
  }>;

  lastResult: AgentResult;
}
```

---

### `AgentResult`

The result from a single agent execution.

```typescript
interface AgentResult {
  success: boolean;
  output: string;          // Raw full output text
  stderr: string;          // Subprocess stderr
  exitCode: number | null;
  result: ParsedResult;    // Parsed from <result> XML envelope
  toolCalls: ToolCallRecord[];
  duration: number;        // Milliseconds
  tokens: { input: number; output: number };
  finishParams?: Record<string, any>;  // Raw finish tool call arguments
}
```

---

### `ParsedResult`

Parsed from the `<result>` XML envelope that agents emit via `finish`.

```typescript
interface ParsedResult {
  status: "complete" | "error" | "blocked" | "unknown";
  files: ResultFile[];
  artifacts: string;  // Raw XML string of <artifacts> block
  summary: string;
}

interface ResultFile {
  path: string;
  action: "created" | "modified" | "read";
}
```

---

### `ToolCallRecord`

```typescript
interface ToolCallRecord {
  toolName: string;
  input: any;
  output: any;
  duration: number;
  isError: boolean;
}
```

---

### `TemplateContext`

The context used to expand template variables (`${{task}}`, `${{input.X}}`, etc.).

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
  forks: Record<string, { answer: string; notes?: string }>;
  loopCounters?: Record<string, number>;
  loopMaxIterations?: Record<string, number>;
}
```

---

### `SubagentEvent` (and variants)

Event types for observing agent execution.

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
```

---

## Dashboard Types

### `WorkflowDefinition`

```typescript
interface WorkflowDefinition {
  id: string;
  stages: WorkflowStage[];
}

interface WorkflowStage {
  name: string;       // Display name in breadcrumb
  flows: string[];    // Flow command names that trigger this stage
  detailFn?: (ctx: any) => string;  // Optional dynamic detail text
}
```

---

### `AgentCardRenderer`

Implement this interface to create a custom dashboard card metric renderer. Register it via [`flow:register-card`](events-api.md#flowregister-card).

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;  // Returns a single metric line
}
```

---

### `CardData`

Internal card state tracked by the dashboard.

```typescript
interface CardData {
  agentName: string;
  status: CardStatus;
  stepId?: string;
  startTime?: number;
  endTime?: number;
  renderer: AgentCardRenderer;
  result?: AgentResult;
}

type CardStatus = "pending" | "running" | "complete" | "error";
```

---

## Core Functions

### `spawnAgent`

Spawn an agent as a subprocess and wait for it to complete. The agent runs its system prompt with the given task and template context, calls `finish`, and the subprocess exits.

```typescript
async function spawnAgent(options: SpawnOptions): Promise<AgentResult>

interface SpawnOptions {
  agent: AgentConfig;
  task: string;
  templateContext: TemplateContext;
  skillContents?: Map<string, string>;    // Pre-loaded skill content
  contextFileContents?: string[];         // Pre-loaded context file content
  getModelRole?: (role: string) => string | undefined;
  cwd: string;                            // Working directory
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  extraGuardFactories?: ExtensionFactory[];
  extraCustomTools?: any[];               // Extension tools to include
  onToolCall?: (toolName: string, input: any) => void;
  onToolResult?: (toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (text: string) => void;
  onThinkingText?: (text: string) => void;
  onExtensionUIRequest?: (request: any, respond: (r: any) => void) => void;
  decisionBranches?: string[];            // Valid branch names for decision agents
  signal?: AbortSignal;
}
```

**Example:**

```typescript
import { spawnAgent, parseAgentFile } from "pi-flows/extensions/flow-engine/index.js";

const agent = parseAgentFile(".pi/flows/agents/researcher.md");
const result = await spawnAgent({
  agent,
  task: "Investigate the authentication module",
  templateContext: { task: "...", inputs: {}, results: {}, forks: {} },
  cwd: process.cwd(),
  getModelRole: (role) => modelRegistry.resolve(role),
  authStorage,
  modelRegistry,
});

console.log(result.result.summary);
```

---

### `runFlow`

Execute a complete flow with DAG scheduling, branching, and all step types. This is the main orchestration function used internally by pi-flows when you run a `/flow-name` command.

```typescript
async function runFlow(options: FlowRunOptions): Promise<FlowResult>

interface FlowRunOptions {
  flow: FlowConfig;
  task: string;
  cwd: string;
  authStorage?: any;
  modelRegistry?: any;
  extraGuardFactories?: any[];
  extraCustomTools?: any[];
  getModelRole?: (role: string) => string | undefined;
  getAgent: (name: string) => AgentConfig | undefined;
  getSkillContent?: (name: string) => string | undefined;
  askUser: (question: string, type: string, options?: string[], extra?: any)
    => Promise<{ answer: string; notes?: string }>;
  onAgentStarted?: (agentName: string, stepId: string) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult) => void;
  onToolCall?: (agentName: string, toolName: string, input: any) => void;
  onToolResult?: (agentName: string, toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (agentName: string, text: string) => void;
  onThinkingText?: (agentName: string, text: string) => void;
  onExtensionUIRequest?: (agentName: string, request: any, respond: (r: any) => void) => void;
  onLoopIteration?: (stepId: string, iteration: number, maxIterations: number) => void;
  isAutonomous?: () => boolean;
  onAutoDecision?: (forkId: string, agentName: string, branch: string, targetStepId: string) => void;
  signal?: AbortSignal;
}
```

**`FlowCancelledError`** — exported error class thrown when the user cancels a fork prompt. Catch this to distinguish user cancellation from runtime errors:

```typescript
import { runFlow, FlowCancelledError } from "pi-flows/extensions/flow-engine/index.js";

try {
  const result = await runFlow({ ... });
} catch (err) {
  if (err instanceof FlowCancelledError) {
    console.log("User cancelled");
  } else {
    throw err;
  }
}
```

---

### `discoverAll`

Scan directories to build agent and flow registries. Returns `DiscoveryResult` with `agents` and `flows` Maps.

```typescript
function discoverAll(
  packageRoot: string,
  projectRoot: string,
  extraAgentsDirs?: string[],
  extraFlowsDirs?: string[],
): DiscoveryResult

interface DiscoveryResult {
  agents: Map<string, AgentConfig>;
  flows: Map<string, FlowConfig>;
}
```

Discovery tiers (later wins on name collision):
1. `extraAgentsDirs` / `extraFlowsDirs` — registered package directories
2. `packageRoot/agents` and `packageRoot/flows` — pi-flows built-ins
3. `projectRoot/.pi/flows/agents` and `projectRoot/.pi/flows/flows` — project-local files

---

### `resolvePackageRoot`

Compute the package root from an `import.meta.url` value. Assumes the calling module is two directories below the package root.

```typescript
function resolvePackageRoot(importMetaUrl: string): string
```

**Example:**

```typescript
import { resolvePackageRoot } from "pi-flows/extensions/flow-engine/index.js";

// In extensions/my-extension/index.ts:
const pkgRoot = resolvePackageRoot(import.meta.url);
// Returns the package root (two directories up from the calling file)
```

---

### `parseAgentFile`

Parse an agent `.md` file from disk into an `AgentConfig`.

```typescript
function parseAgentFile(filePath: string): AgentConfig
```

Throws if the file is missing required frontmatter fields (`name`, `description`, `model`).

---

### `parseAgentString`

Parse an agent definition from a raw string. Useful for testing or inline definitions.

```typescript
function parseAgentString(content: string, source: string): AgentConfig
```

`source` is stored on the returned config as the `source` field (used for diagnostics).

---

### `parseFlowYamlFile`

Parse a `.yaml` flow file from disk into a `FlowConfig`.

```typescript
function parseFlowYamlFile(filePath: string): FlowConfig
```

---

### `parseFlowYamlString`

Parse a flow definition from a raw YAML string.

```typescript
function parseFlowYamlString(content: string, source: string): FlowConfig
```

---

### `expandTemplateVariables`

Expand all `${{...}}` and legacy `{...}` template variables in a string using a `TemplateContext`.

```typescript
function expandTemplateVariables(template: string, ctx: TemplateContext): string
```

**Example:**

```typescript
import { expandTemplateVariables } from "pi-flows/extensions/flow-engine/index.js";

const expanded = expandTemplateVariables(
  "Implement ${{task}} based on: ${{result.researcher.summary}}",
  {
    task: "auth module",
    inputs: {},
    results: { researcher: { summary: "JWT tokens are used", ... } },
    forks: {},
  }
);
// → "Implement auth module based on: JWT tokens are used"
```

---

### `resolveModel`

Resolve a model reference string (role alias or model ID) to a concrete model ID and optional thinking level.

```typescript
function resolveModel(
  modelRef: string,
  thinking?: string,
  getModelRole?: (role: string) => string | undefined,
): { modelId: string; thinking?: string }
```

Supported formats:
- `"@coding"` — role alias, resolved via `getModelRole`
- `"claude-sonnet-4-20250514"` — direct model ID
- `"claude-sonnet-4-20250514:high"` — model ID with thinking suffix

---

### `parseResult`

Parse a `<result>` XML envelope from raw agent output text.

```typescript
function parseResult(output: string): ParsedResult
```

If no `<result>` block is found, returns a fallback with `status: "unknown"` and the raw output (truncated to 2000 chars) as the summary.

---

### `hasArtifactElement`

Check whether a `<result>` output contains any `<artifacts>` content. Used by `conditional` steps.

```typescript
function hasArtifactElement(output: string): boolean
```

---

## Dashboard Functions

### `resolveWorkflow`

Find which workflow and stage a given flow name belongs to.

```typescript
function resolveWorkflow(
  flowName: string,
): { workflow: WorkflowDefinition; stageIndex: number } | null
```

Returns `null` if the flow name is not registered in any workflow.

---

### `registerWorkflow`

Register a workflow definition programmatically (equivalent to emitting `flow:register-workflow`).

```typescript
function registerWorkflow(def: WorkflowDefinition): void
```

---

### `getCardRenderer`

Get the registered card renderer factory for a metric type.

```typescript
function getCardRenderer(metricType: string): (() => AgentCardRenderer) | undefined
```

---

### `registerMetric`

Register a card metric renderer factory (equivalent to emitting `flow:register-card`).

```typescript
function registerMetric(name: string, factory: () => AgentCardRenderer): void
```
