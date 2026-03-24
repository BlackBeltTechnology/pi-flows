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

> **Note:** Because pi uses jiti for dynamic loading, module identity can differ between extensions loaded separately. pi-flows uses `Symbol.for()` and global state for registries that must be shared. If you encounter module identity issues, use the event-based APIs (e.g., `flow:get-agents`) instead of direct imports.

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
  allowCustom?: boolean;
  multiSelect?: boolean;
  decisionAgent?: string;
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

Result from a single agent execution (subprocess).

```typescript
interface AgentResult {
  success: boolean;             // Whether the agent completed successfully
  output: string;               // Raw full output text
  stderr: string;               // Subprocess stderr (diagnostics)
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
  chainDir: string;
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

Event types for tracking agent subprocess activity.

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

Spawn a pi subprocess to execute a single agent. Returns the full `AgentResult` including output, tool calls, tokens, and parsed result.

```typescript
interface SpawnOptions {
  agent: AgentConfig;
  task: string;
  templateContext: TemplateContext;
  skillContents?: Map<string, string>;
  contextFileContents?: string[];
  getModelRole?: (role: string) => string | undefined;
  cwd: string;
  guardExtPath: string;
  onToolCall?: (toolName: string, input: any) => void;
  onToolResult?: (toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (text: string) => void;
  onThinkingText?: (text: string) => void;
  decisionBranches?: string[];
  allowSubagent?: boolean;
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
  guardExtPath: string;
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
  onLoopIteration?: (stepId: string, iteration: number, maxIterations: number) => void;
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

Resolve the pi-flows package root directory.

```typescript
function resolvePackageRoot(): string
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
