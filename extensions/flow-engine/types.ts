// ---------------------------------------------------------------------------
// Flow Engine -- Type Definitions
//
// Generic flow orchestration types. No framework-specific dependencies.
// ---------------------------------------------------------------------------

// ---- Card display configuration (from agent frontmatter card: block) ------

export interface CardConfig {
  label?: string;
  metric?: string;
  role?: string;
}

// ---- Architect metadata (from agent frontmatter architect: block) ---------

export interface ArchitectMeta {
  use_when?: string;
  produces?: string;
  depends_on?: string;
  domain?: string;
}

// ---- Agent configuration (parsed from .md frontmatter) --------------------

export interface AgentConfig {
  name: string;
  description: string;
  model: string; // e.g., "@planning", "@coding", or explicit model ID
  thinking?: string; // off, minimal, low, medium, high, xhigh
  tools: string[]; // e.g., ["read", "write", "edit", "grep", "bash"]
  skills?: string[]; // e.g., ["judo-backend-docs"]
  inputs?: string[]; // Declared input names (contract for flow wiring)
  outputs?: Array<{name: string, description?: string}>; // Declared output names (contract for result wiring)
  systemPrompt: string; // The body of the .md file (prompt template with {task}, {input.*}, etc.)
  output?: string; // Default output filename
  interactive?: boolean;
  source: string; // File path where this agent was discovered
  access?: AccessRules; // Inline access control from frontmatter
  card?: CardConfig; // Card display configuration from frontmatter
  architect?: ArchitectMeta; // Optional architect-facing metadata
}

// ---- Access control rules (from agent frontmatter) ------------------------

export interface AccessRules {
  read?: string[]; // Glob patterns for allowed read paths
  write?: string[]; // Glob patterns for allowed write paths
  bash?: {
    deny: string[]; // Command patterns to block
  };
}

// ---- Flow configuration (parsed from .yaml flow files) --------------------

export interface FlowConfig {
  name: string;
  description: string;
  max_concurrent?: number;
  task_required?: boolean; // Prompt user for task if no command args provided
  task_prompt?: string; // Custom prompt text (default: "Describe what you want <name> to do:")
  steps: FlowStep[];
  source: string; // File path where this flow was discovered
}

// ---- Flow steps (discriminated union on `stepType`) -----------------------

export type FlowStep =
  | AgentStep
  | ForkStep
  | ConditionalStep
  | AgentDecisionStep
  | AgentLoopDecisionStep
  | FlowRefStep;

export interface AgentStep {
  stepType: "agent";
  id: string; // Step identifier (usually agent name)
  agent: string; // Agent name to dispatch
  task?: string; // Optional task override (template string)
  output?: string; // Output file
  reads?: string[]; // PARSED BUT NOT WIRED — parsed in flow-parser-yaml but never consumed in execution
  inputs?: Record<string, string>; // Named inputs wired from template expressions
  blockedBy?: string[]; // Step IDs that must complete before this step runs
  on_complete?: string; // Route to step ID on success
  on_error?: string; // Route to step ID on error
}

export interface ForkStep {
  stepType: "fork";
  id: string;
  question: string;
  options: string[];
  branches: Record<string, string>; // option -> step ID mapping
  allowCustom?: boolean;  // Appends "Other (describe)" option. Custom freetext routes through the fork's agent. Requires agent: field.
  multiSelect?: boolean;
  agent?: string;         // Agent to use when auto-deciding (autonomous mode)
  task?: string;          // Context/task for the agent when auto-deciding
}

export interface ConditionalStep {
  stepType: "conditional";
  id: string;
  check: string; // e.g., "artifacts.gaps"
  present: string; // Step ID if present
  absent: string; // Step ID if absent
}

export interface AgentDecisionStep {
  stepType: "agent-decision";
  id: string;
  agent: string; // Agent to dispatch for decision
  task: string; // Task for the decision agent
  branches: Record<string, string>; // branch name -> step ID mapping
}

export interface AgentLoopDecisionStep {
  stepType: "agent-loop-decision";
  id: string;
  agent: string; // Agent to dispatch for loop decision
  task: string; // Task for the decision agent (template string)
  loop_target: string; // Step ID to jump back to (backward jump)
  exit_target: string; // Step ID to continue to (forward)
  max_iterations: number; // Safety cap — force exit when exceeded
}

export interface FlowRefStep {
  stepType: "flow-ref";
  id: string;
  path: string; // Path or glob to flow file(s)
  on_complete?: string;
  on_error?: string;
}

// ---- Routing directives ---------------------------------------------------

export interface StepRouting {
  on_complete?: string;
  on_error?: string;
}

// ---- Agent execution results ----------------------------------------------

export interface AgentResult {
  success: boolean;
  output: string; // Raw full output text
  stderr: string; // Subprocess stderr (for diagnostics)
  exitCode: number | null; // Process exit code
  result: ParsedResult; // Parsed from <result> envelope
  toolCalls: ToolCallRecord[];
  duration: number; // ms
  tokens: { input: number; output: number };
  finishParams?: Record<string, any>; // Raw finish tool call args (if captured)
  typedOutputs?: Record<string, string>; // Extracted typed output values from declared agent outputs
  /**
   * True when the step did not complete because the run was cancelled
   * mid-batch via AbortSignal. See change: fix-pi-flows-end-to-end (Group 3).
   */
  cancelled?: boolean;
}

export interface ToolCallRecord {
  toolName: string;
  input: any;
  output: any;
  duration: number;
  isError: boolean;
}

// ---- Parsed <result> XML envelope -----------------------------------------

export interface ParsedResult {
  status: "complete" | "error" | "blocked" | "unknown";
  files: ResultFile[];
  artifacts: string; // Raw XML string of <artifacts> block
  summary: string;
}

export interface ResultFile {
  path: string;
  action: "created" | "modified" | "read";
}

// ---- Subagent events ------------------------------------------------------

export type SubagentEventType =
  | "started"
  | "complete"
  | "tool_call"
  | "tool_result";

export interface SubagentEvent {
  type: SubagentEventType;
  agentName: string;
  flowName?: string;
  stepId?: string;
  timestamp: number;
  data: any; // Event-specific payload
}

export interface SubagentStartedEvent extends SubagentEvent {
  type: "started";
  data: { task: string; model: string };
}

export interface SubagentCompleteEvent extends SubagentEvent {
  type: "complete";
  data: AgentResult;
}

export interface SubagentToolCallEvent extends SubagentEvent {
  type: "tool_call";
  data: { toolName: string; input: any };
}

export interface SubagentToolResultEvent extends SubagentEvent {
  type: "tool_result";
  data: { toolName: string; output: any; isError: boolean };
}

// ---- Enriched flow result (returned by runFlow) ---------------------------

export interface FlowResult {
  lastResult: AgentResult;
  results: Record<string, { fullOutput: string; status: string; summary: string; artifacts: string; files: string; [key: string]: string }>;
  forks: Record<string, { answer: string; notes?: string }>;
  flowName: string;
  stepCount: number;
  totalDuration: number; // wall-clock ms for entire flow
  status?: "success" | "error" | "aborted"; // outcome — absent on legacy results
}

// ---- Template context for variable expansion ------------------------------

export interface TemplateContext {
  task: string;
  inputs: Record<string, string>;
  results: Record<
    string,
    {
      fullOutput: string;
      status: string;
      summary: string;
      artifacts: string;
      files: string;
      [key: string]: string; // Typed outputs from agent declarations
    }
  >;
  loopCounters?: Record<string, number>;
  loopMaxIterations?: Record<string, number>;
}
