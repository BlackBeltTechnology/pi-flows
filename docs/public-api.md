# Public API Reference

pi-flows exports its core types and functions from `pi-flows/extensions/flow-engine/index.js`. These are useful when building tools that run flows programmatically (CI integrations, test harnesses, custom commands) or when extending the dashboard.

---

## Import paths

```typescript
// Core engine: types, execution, discovery, parsing
import type {
  AgentConfig, FlowConfig, FlowResult, AgentResult,
  FlowStep, AgentStep, ForkStep, ConditionalStep,
  AgentDecisionStep, AgentLoopDecisionStep, FlowRefStep, CodeStep,
  CodeNodeContext, CodeNodeHandler,
  TemplateContext, SubagentEvent, ArchitectMeta, CardConfig,
  FlowRunOptions, FlowContext, FlowIOAdapter, FlowObserver,
} from "pi-flows/extensions/flow-engine/index.js";

import {
  spawnAgent, expandTemplateVariables,
  runFlow, FlowCancelledError,
  discoverAll, resolvePackageRoot,
  resolveModel,
  parseResult, hasArtifactElement,
  parseAgentFile, parseAgentString,
  parseFlowYamlFile, parseFlowYamlString,
  FlowManager, FlowHardError,
  classifyAgentOutcome, classifyThrownError, resolveRouteOutcome,
} from "pi-flows/extensions/flow-engine/index.js";

// Dashboard types
import type {
  WorkflowDefinition, WorkflowStage,
  AgentCardRenderer, CardStatus, CardData,
  DashboardMode, DetailEntry, DetailViewData,
  DetailScrollState, AgentDetailOverlayOptions,
  FlowPreviewOverlayOptions, BoxOptions,
} from "pi-flows/extensions/flow-dashboard/index.js";

import {
  registerWorkflow, resolveWorkflow,
  getCardRenderer, initCardTypes, registerMetric,
  AgentDashboard,
  renderBreadcrumb, renderDetailView,
  createDetailScrollState, moveUp, moveDown,
  toggleExpand, computeExpandedContentLines,
  createAgentDetailOverlay, createFlowPreviewOverlay,
  renderBox, padLine,
} from "pi-flows/extensions/flow-dashboard/index.js";
```

---

## Core Types

### `AgentConfig`

Parsed agent definition (from a `.md` file).

```typescript
interface AgentConfig {
  name:         string;
  description:  string;
  model:        string;             // e.g., "@planning", "claude-sonnet-4:high"
  thinking?:    string;             // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  tools:        string[];           // e.g., ["read", "grep", "bash"]
  skills?:      string[];           // e.g., ["my-backend-docs"]
  inputs?:      string[];           // declared input names
  outputs?:     Array<{ name: string; description?: string }>;
  systemPrompt: string;             // body of the .md file (template string)
  output?:      string;             // default output file
  interactive?: boolean;
  source:       string;             // absolute file path
  access?:      AccessRules;
  card?:        CardConfig;
  architect?:   ArchitectMeta;
}

interface AccessRules {
  read?:  string[];            // glob patterns for allowed reads
  write?: string[];            // glob patterns for allowed writes
  bash?:  { deny: string[] };  // command patterns to block
}
```

---

### `FlowConfig`

Parsed flow definition (from a `.yaml` file).

```typescript
interface FlowConfig {
  name:           string;
  description:    string;
  max_concurrent?: number;      // parallel agent cap (default: 4)
  task_required?:  boolean;
  task_prompt?:    string;
  steps:           FlowStep[];
  source:          string;       // absolute file path
}
```

---

### `FlowStep` (discriminated union)

```typescript
type FlowStep =
  | AgentStep
  | ForkStep
  | ConditionalStep
  | AgentDecisionStep
  | AgentLoopDecisionStep
  | FlowRefStep
  | CodeStep;

interface AgentStep {
  stepType:    "agent";
  id:          string;
  agent:       string;
  task?:       string;
  output?:     string;
  reads?:      string[];
  inputs?:     Record<string, string>;   // key → template expression
  blockedBy?:  string[];
  on_complete?: string;
  on_error?:   string;
}

interface ForkStep {
  stepType:    "fork";
  id:          string;
  question:    string;
  options:     string[];
  branches:    Record<string, string>;   // option text → step ID
  allowCustom?: boolean;
  multiSelect?: boolean;
  agent?:      string;
  task?:       string;
}

interface ConditionalStep {
  stepType: "conditional";
  id:       string;
  check:    string;    // "stepId.field"
  present:  string;    // step ID if field has content
  absent:   string;    // step ID if field is empty
}

interface AgentDecisionStep {
  stepType: "agent-decision";
  id:       string;
  agent:    string;
  task:     string;
  branches: Record<string, string>;   // branch name → step ID
}

interface AgentLoopDecisionStep {
  stepType:       "agent-loop-decision";
  id:             string;
  agent:          string;
  task:           string;
  loop_target:    string;
  exit_target:    string;
  max_iterations: number;
}

interface FlowRefStep {
  stepType:    "flow-ref";
  id:          string;
  path:        string;
  on_complete?: string;
  on_error?:   string;
}

interface CodeStep {
  stepType:    "code";
  id:          string;
  inputs?:     Record<string, string>;    // key → template expression
  outputs?:    Array<{ name: string }>;  // declared output names
  target?:     string;                    // overrides handler file path
  blockedBy?:  string[];
  on_complete?: string;
  on_error?:   string;
  timeout?:    number;                    // soft deadline — milliseconds
}
```

---

### `AgentResult`

Result of running a single agent step.

```typescript
interface AgentResult {
  success:       boolean;
  output:        string;             // full raw output text
  stderr:        string;             // subprocess stderr
  exitCode:      number | null;
  result:        ParsedResult;       // parsed from finish tool call
  toolCalls:     ToolCallRecord[];
  duration:      number;             // milliseconds
  tokens:        { input: number; output: number };
  finishParams?: Record<string, any>; // raw finish tool call parameters
  typedOutputs?: Record<string, string>; // extracted typed outputs
  outcome?:      FailureOutcome;       // structural failure classification
  failureInfo?:  FailureInfo;          // present on soft/hard failures
}

interface ParsedResult {
  status:    "complete" | "error" | "blocked" | "unknown";
  files:     ResultFile[];
  artifacts: string;   // raw XML artifacts string
  summary:   string;
}

interface ResultFile {
  path:   string;
  action: "created" | "modified" | "read";
}

interface ToolCallRecord {
  toolName:  string;
  input:     any;
  output:    any;
  duration:  number;   // milliseconds
  isError:   boolean;
}
```

---

### `FailureOutcome`

The three terminal outcomes a node can resolve to.

```typescript
type FailureOutcome = "success" | "soft" | "hard";
```

- `success` — routes to the node's `on_complete`.
- `soft` — recoverable; routes to `on_error`, or hard-fails the flow if no `on_error` is declared.
- `hard` — unrecoverable; aborts in-flight steps, skips pending steps, and ends the flow with status `error`.

See [flows.md → Failure Modes](./flows.md#failure-modes) for the full routing model.

---

### `FailureInfo`

Detail attached to a non-success outcome.

```typescript
interface FailureInfo {
  outcome: "soft" | "hard";
  message: string;   // surfaced in the flow result on a hard fail
  source:  string;   // step ID / origin of the failure
}
```

---

### `FlowResult`

Result of running a complete flow.

```typescript
interface FlowResult {
  lastResult:    AgentResult;
  results:       Record<string, StepResultEntry>;  // step ID → result
  forks:         Record<string, { answer: string; notes?: string }>;
  flowName:      string;
  stepCount:     number;
  totalDuration: number;    // wall-clock milliseconds
  status?:       "success" | "error" | "aborted";
}
```

On a **hard** failure, `status` is `"error"` and the reason is carried in `lastResult` (its `failureInfo.message`).

```typescript

interface StepResultEntry {
  fullOutput:  string;
  status:      string;      // "complete" | "error" | "blocked" | "aborted" | "skipped"
  summary:     string;
  artifacts:   string;
  files:       string;
  [key: string]: string;   // typed outputs
}
```

---

### `TemplateContext`

Context object passed to `expandTemplateVariables`.

```typescript
interface TemplateContext {
  task:    string;
  inputs:  Record<string, string>;
  results: Record<string, {
    fullOutput:  string;
    status:      string;
    summary:     string;
    artifacts:   string;
    files:       string;
    [key: string]: string;  // typed outputs
  }>;
  loopCounters?:     Record<string, number>;
  loopMaxIterations?: Record<string, number>;
}
```

---

### `CardConfig`

Agent card display configuration (from agent frontmatter).

```typescript
interface CardConfig {
  label?:  string;   // display name in the card header
  metric?: string;   // metric renderer name
  role?:   string;   // role label
}
```

---

### `ArchitectMeta`

Architect-facing metadata (from agent frontmatter).

```typescript
interface ArchitectMeta {
  use_when?:   string;
  produces?:   string;
  depends_on?: string;
  domain?:     string;
}
```

---

### `SubagentEvent`

Events emitted during agent execution (for streaming observers).

```typescript
type SubagentEventType = "started" | "complete" | "tool_call" | "tool_result";

interface SubagentEvent {
  type:       SubagentEventType;
  agentName:  string;
  flowName?:  string;
  stepId?:    string;
  timestamp:  number;
  data:       any;
}
```

---

### `FlowRunOptions`

Options for `runFlow()`.

```typescript
interface FlowRunOptions {
  flow:                FlowConfig;
  task:                string;
  cwd:                 string;
  authStorage?:        any;
  modelRegistry?:      any;
  extraAgentExtensions?: any[];
  extraCustomTools?:   any[];
  getModelRole?:       (role: string) => string | undefined;
  getAgent:            (name: string) => AgentConfig | undefined;
  getSkillContent?:    (name: string) => string | undefined;
  askUser:             (question: string, type: string, options?: string[], extra?: any)
                         => Promise<{ answer: string; notes?: string }>;
  // Callbacks
  onAgentStarted?:     (agentName: string, stepId: string, resolvedModel?: string) => void;
  onAgentComplete?:    (agentName: string, stepId: string, result: AgentResult) => void;
  onToolCall?:         (agentName: string, stepId: string, toolName: string, input: any) => void;
  onToolResult?:       (agentName: string, stepId: string, toolName: string, output: any, isError: boolean) => void;
  onAssistantText?:    (agentName: string, stepId: string, text: string) => void;
  onThinkingText?:     (agentName: string, stepId: string, text: string) => void;
  onLoopIteration?:    (stepId: string, iteration: number, maxIterations: number, loopTarget?: string) => void;
  onAutoDecision?:     (forkId: string, agentName: string, chosenBranch: string, targetStepId: string) => void;
  onNotify?:           (message: string) => void;
  isAutonomous?:       () => boolean;
  signal?:             AbortSignal;
}
```

---

### `FlowContext`

Internal context passed through flow execution (available in `FlowRunOptions` callbacks via closure).

```typescript
interface FlowContext {
  task:                string;
  results:             Record<string, StepResultEntry>;
  forks:               Record<string, { answer: string; notes?: string }>;
  loopCounters:        Record<string, number>;
  loopMaxIterations:   Record<string, number>;
  steps:               FlowStep[];
}
```

---

### `FlowIOAdapter` and `FlowObserver`

Extension points for the `FlowManager`.

```typescript
interface FlowIOAdapter {
  askUser(question: string, type: string, options?: string[], extra?: any): Promise<{ answer: string; notes?: string }>;
  onFlowStart?(flowName: string): void;
  onFlowEnd?(): void;
}

interface FlowObserver {
  onFlowStarted?(flowName: string, flow: FlowConfig, task: string): void;
  onAgentStarted?(agentName: string, stepId: string, resolvedModel?: string): void;
  onAgentComplete?(agentName: string, stepId: string, result: AgentResult): void;
  onAssistantText?(agentName: string, stepId: string, text: string): void;
  onThinkingText?(agentName: string, stepId: string, text: string): void;
  onToolCall?(agentName: string, stepId: string, toolName: string, input: any): void;
  onToolResult?(agentName: string, stepId: string, toolName: string, output: any, isError: boolean): void;
  onLoopIteration?(stepId: string, iteration: number, maxIterations: number, loopTarget?: string): void;
  onAutoDecision?(forkId: string, agentName: string, chosenBranch: string, targetStepId: string): void;
  onFlowComplete?(result: FlowResult): void;
}
```

---

## Core Functions

### `runFlow(options)`

Execute a flow to completion. Returns a `FlowResult`.

```typescript
async function runFlow(options: FlowRunOptions): Promise<FlowResult>
```

```typescript
import { runFlow, parseFlowYamlFile, parseAgentFile, discoverAll } from "pi-flows/extensions/flow-engine/index.js";

const { agents, flows } = discoverAll(pkgRoot, projectRoot);

const result = await runFlow({
  flow:     flows.get("my-flow")!,
  task:     "Implement the login feature",
  cwd:      process.cwd(),
  getAgent: (name) => agents.get(name),
  askUser:  async (question, type, options) => {
    // Handle UI prompts — return answer synchronously or via stdin
    console.log(question);
    return { answer: options?.[0] ?? "yes" };
  },
  onAgentComplete: (agentName, _stepId, result) => {
    console.log(`[${agentName}] done: ${result.result.summary}`);
  },
});

console.log(`Flow "${result.flowName}" finished in ${result.totalDuration}ms`);
```

Throws `FlowCancelledError` if `askUser` resolves with cancellation. Re-throws other errors.

---

### `spawnAgent(options)`

Run a single agent session. Lower-level than `runFlow`.

```typescript
async function spawnAgent(options: SpawnOptions): Promise<AgentResult>
```

`SpawnOptions` includes: `agent`, `task`, `templateContext`, `skillContents`, `cwd`, `authStorage`, `modelRegistry`, `extraAgentExtensions`, `extraCustomTools`, and streaming callbacks.

---

### `expandTemplateVariables(template, ctx)`

Expand `${{...}}` expressions in a template string.

```typescript
function expandTemplateVariables(template: string, ctx: TemplateContext): string
```

```typescript
import { expandTemplateVariables } from "pi-flows/extensions/flow-engine/index.js";

const expanded = expandTemplateVariables(
  "Implement: ${{task}}\nContext: ${{input.research}}",
  {
    task: "Add OAuth",
    inputs: { research: "OAuth requires..." },
    results: {},
  }
);
// → "Implement: Add OAuth\nContext: OAuth requires..."
```

---

### `discoverAll(packageRoot, projectRoot, extraAgentsDirs?, extraFlowsDirs?)`

Discover agents and flows from all registered directories.

```typescript
function discoverAll(
  packageRoot: string,
  projectRoot: string,
  extraAgentsDirs?: string[],
  extraFlowsDirs?: string[],
): DiscoveryResult

interface DiscoveryResult {
  agents:   Map<string, AgentConfig>;
  flows:    Map<string, FlowConfig>;
  warnings: string[];
}
```

Discovery priority (highest wins on name collision):
1. Project-local (`.pi/flows/`)
2. `extraAgentsDirs` / `extraFlowsDirs` (registration order)
3. pi-flows package built-ins

---

### `resolvePackageRoot(importMetaUrl)`

Resolve the package root from a module's `import.meta.url`. Assumes the calling module is two directories below the root.

```typescript
function resolvePackageRoot(importMetaUrl: string): string

// Usage in an extension:
const pkgRoot = resolvePackageRoot(import.meta.url);
// → /home/user/my-package
```

---

### `resolveModel(modelRef, thinking?, getModelRole?)`

Resolve a model reference string to a concrete model ID and thinking level.

```typescript
function resolveModel(
  modelRef:     string,
  thinking?:    string,
  getModelRole?: (role: string) => string | undefined,
): { modelId: string; thinking?: string }
```

```typescript
resolveModel("@planning", undefined, (r) => roles.get(r));
// → { modelId: "claude-opus-4-20250514", thinking: undefined }

resolveModel("claude-sonnet-4:high");
// → { modelId: "claude-sonnet-4", thinking: "high" }

resolveModel("claude-haiku-3");
// → { modelId: "claude-haiku-3", thinking: undefined }
```

---

### `parseAgentFile(filePath)` / `parseAgentString(content, source)`

Parse an agent `.md` file.

```typescript
function parseAgentFile(filePath: string): AgentConfig
function parseAgentString(content: string, source: string): AgentConfig
```

Throws if required frontmatter fields (`name`, `description`, `model`) are missing.

---

### `parseFlowYamlFile(filePath)` / `parseFlowYamlString(content, source)`

Parse a flow `.yaml` file.

```typescript
function parseFlowYamlFile(filePath: string): FlowConfig
function parseFlowYamlString(content: string, source: string): FlowConfig
```

Throws if required fields (`name`, `description`, `steps`) are missing or the YAML is malformed.

---

### `parseResult(output)` / `hasArtifactElement(output)`

Parse the structured result from an agent's raw output text (legacy XML envelope format).

```typescript
function parseResult(output: string): ParsedResult
function hasArtifactElement(output: string): boolean
```

These are used internally by the engine. You typically don't need them directly — `AgentResult.result` is already parsed.

---

### `CodeNodeContext`

Context object passed as the second argument to every code-step handler. Exported from the package entrypoint.

```typescript
interface CodeNodeContext {
  /** Cooperative cancellation signal. Aborted when the step’s `timeout` expires or the flow is cancelled. */
  signal:      AbortSignal;
  /** Absolute path to the project root (same as `cwd` in `FlowRunOptions`). */
  cwd:         string;
  /** Stream a message to the step’s card in real time. */
  logger:      (msg: string) => void;
  /** Set the step’s summary text (becomes `${{result.id.summary}}` downstream). */
  setSummary:  (text: string) => void;
  /** Name of the running flow. */
  flowName:    string;
  /** The step’s `id` field. */
  stepId:      string;
  /** The task string passed when the flow was invoked. */
  task:        string;
}
```

```typescript
import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

export default async function (input: { invoice: string }, ctx: CodeNodeContext) {
  ctx.logger("validating...");
  if (ctx.signal.aborted) throw new Error("cancelled");
  ctx.setSummary("Validation complete");
  return { valid: "true" };
}
```

---

### `CodeNodeHandler`

Helper type for declaring a typed code-step handler. The generic parameters `I` (input shape) and `O` (output shape) match the step’s `inputs` and `outputs` declarations.

```typescript
type CodeNodeHandler<I = Record<string, string>, O = Record<string, string>> =
  (input: I, ctx: CodeNodeContext) => Promise<O>;
```

```typescript
import type { CodeNodeContext, CodeNodeHandler } from "@blackbelt-technology/pi-flows";

interface Input  { invoice: string }
interface Output { valid: string; nav_record: string }

const handler: CodeNodeHandler<Input, Output> = async (input, ctx) => {
  return { valid: "true", nav_record: "..." };
};

export default handler;
```

---

### `FlowHardError`

A marker error class. Throw it from a code step (or any extension node) to force an **unconditional hard failure** that halts the flow regardless of any `on_error` target. A plain `throw` (any other `Error`) is treated as a recoverable **soft** failure.

```typescript
class FlowHardError extends Error {
  constructor(message: string);
}
```

```typescript
import { FlowHardError } from "@blackbelt-technology/pi-flows";
// or from the internal path:
import { FlowHardError } from "pi-flows/extensions/flow-engine/index.js";

// Soft failure — routes to on_error (or hard-fails if none declared):
throw new Error("validation failed");

// Hard failure — stops the whole flow immediately:
if (!apiKey) {
  throw new FlowHardError("Missing API key; provider unusable for the rest of the flow");
}
```

See [flows.md → Failure Modes](./flows.md#failure-modes) for the full routing model.

---

### Outcome classification helpers

The engine uses these to resolve a node's `FailureOutcome`. They are exported for tooling and tests.

| Function | Description |
|----------|-------------|
| `classifyAgentOutcome(finishParams, lastApiError)` | Classifies an agent end state into `success` / `soft` / `hard` from its `finish` params and any terminal API error. |
| `classifyThrownError(err)` | Classifies a thrown error: `FlowHardError` → `hard`, any other `Error` → `soft`. |
| `resolveRouteOutcome(result, onError)` | Resolves the effective route for a result: a `soft` failure with no `onError` target escalates to `hard`. |

---

## `FlowManager` class

High-level orchestrator for running flows with I/O adapters and observers.

```typescript
class FlowManager {
  constructor(
    config:    FlowManagerConfig,
    ioAdapter: FlowIOAdapter,
    observers: FlowObserver[],
  );

  get isRunning(): boolean;
  get activeFlowName(): string | null;

  setIOAdapter(adapter: FlowIOAdapter): void;
  addObserver(observer: FlowObserver): void;
  insertObserver(observer: FlowObserver): void;

  abort(): void;
  start(options: { flow: FlowConfig; flowName: string; task: string }): Promise<void>;
}

interface FlowManagerConfig {
  getAgents:              () => Map<string, AgentConfig>;
  getModelRole:           () => ((role: string) => string | undefined) | undefined;
  getProjectRoot:         () => string;
  getPkgRoot:             () => string;
  getAuthStorage:         () => any;
  getModelRegistry:       () => any;
  getExtraAgentExtensions: () => any[];
  getExtensionTools:      () => any[];
  getSkillContent:        (name: string) => string | undefined;
  isAutonomous:           () => boolean;
}
```

---

## Dashboard Types

### `WorkflowDefinition` / `WorkflowStage`

```typescript
interface WorkflowDefinition {
  id:     string;
  stages: WorkflowStage[];
}

interface WorkflowStage {
  name:      string;    // display name in breadcrumb
  flows:     string[];  // flow names that map to this stage
  detailFn?: (ctx: any) => string;  // dynamic detail text
}
```

### `AgentCardRenderer`

```typescript
interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string;
}
```

### `CardData`

```typescript
interface CardData {
  agentName:  string;
  status:     CardStatus;   // "pending" | "running" | "complete" | "error" | "blocked"
  stepId?:    string;
  startTime?: number;
  endTime?:   number;
  renderer:   AgentCardRenderer;
  result?:    AgentResult;
}

type CardStatus = "pending" | "running" | "complete" | "error" | "blocked";
```

### Dashboard functions

| Function | Description |
|----------|-------------|
| `registerWorkflow(def)` | Register a `WorkflowDefinition` in the registry. |
| `resolveWorkflow(flowName)` | Look up the workflow and stage index for a given flow name. |
| `getCardRenderer(name)` | Get the registered renderer factory for a card metric name. |
| `initCardTypes()` | Initialize built-in metric renderers (default, files, tests). |
| `registerMetric(name, factory)` | Register a custom metric renderer factory. |
| `renderBreadcrumb(workflow, stageIndex, width, theme)` | Render the pipeline breadcrumb to a string. |
| `renderBox(content, options)` | Render a TUI box with border and title. |
