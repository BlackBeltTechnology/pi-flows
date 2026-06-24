// ---------------------------------------------------------------------------
// Flow Engine -- Type Definitions
//
// Generic flow orchestration types. No framework-specific dependencies.
// ---------------------------------------------------------------------------

// ---- Node failure model ----------------------------------------------------

/**
 * The outcome of a single node execution.
 *
 * - `success` — node completed; routes to its `on_complete`.
 * - `soft`    — recoverable failure; routes to its `on_error`, or hard-fails
 *               the flow when no `on_error` is declared.
 * - `hard`    — unrecoverable failure; aborts in-flight parallel steps, skips
 *               pending steps, and ends the flow with status `error`.
 */
export type FailureOutcome = "success" | "soft" | "hard";

/** Structured detail for a non-success node outcome. */
export interface FailureInfo {
  /** `soft` or `hard` — never `success`. */
  outcome: "soft" | "hard";
  /** Human-readable failure message surfaced to the flow result / dashboard. */
  message: string;
  /**
   * Where the classification came from, for diagnostics. Examples:
   * `agent_finish_error`, `agent_no_finish`, `api_error`, `thrown_error`,
   * `flow_hard_error`, `agent_not_found`.
   */
  source: string;
}

/**
 * Marker error for code/extension nodes to request an unconditional HARD
 * failure. A plain `throw` (any non-`FlowHardError` error) is classified SOFT;
 * `throw new FlowHardError(msg)` is HARD and halts the flow regardless of
 * `on_error`. Exported from the package entrypoint as public API.
 */
export class FlowHardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowHardError";
    // Restore the prototype chain so `instanceof FlowHardError` survives
    // transpilation to ES5-style constructors.
    Object.setPrototypeOf(this, FlowHardError.prototype);
  }
}

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

// ---- Agent output declaration (from frontmatter outputs: block) -----------

export interface AgentOutput {
  name: string;
  description?: string;
  /** Content constraint on the (always string-valued) output. */
  type?: "string" | "number" | "boolean";
  /** Regex the string value MUST match. Explicit pattern wins over type. */
  pattern?: string;
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
  outputs?: AgentOutput[]; // Declared output names + optional type/pattern (contract for result wiring)
  systemPrompt: string; // The body of the .md file (prompt template with {task}, {input.*}, etc.)
  output?: string; // Default output filename
  interactive?: boolean;
  fork_session?: boolean; // Inherit operator session data via SessionManager.forkFrom (default off)
  context_files?: string[]; // Paths pre-read at spawn and injected into the system prompt
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
  | CodeStep
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

export interface CodeStep {
  stepType: "code";
  id: string; // Step identifier (becomes default handler filename)
  target?: string; // Optional override handler path (default: .pi/flows/handlers/<flow>/<id>.ts)
  inputs?: Record<string, string>; // Named inputs wired from template expressions
  outputs?: Array<{ name: string }>; // Declared output names (strings only)
  blockedBy?: string[]; // Step IDs that must complete before this step runs
  on_complete?: string; // Route to step ID on success
  on_error?: string; // Route to step ID on error
  timeout?: number; // Optional soft timeout in milliseconds
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
  /**
   * Structural outcome classification (success | soft | hard). Set by
   * `classifyAgentOutcome`. The DAG scheduler routes on this, not on `success`.
   */
  outcome?: FailureOutcome;
  /** Failure detail when `outcome` is `soft` or `hard`. */
  failureInfo?: FailureInfo;
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

// ---- Persisted flow-event record ------------------------------------------

// Shape of the custom session entry (customType "flow-event") written via
// pi.appendEntry for each flow-run lifecycle event. This is the cross-repo
// contract the dashboard's replay path consumes to rebuild flow cards on
// reload. See openspec/changes/persist-flow-runs.
export interface FlowEventRecord {
  // Monotonic per session; replay orders by this to reproduce live ordering.
  seq: number;
  // The dashboard PROTOCOL event name (mapped), e.g. "flow_tool_call" — NOT
  // the raw "flow:*" channel name. Lets a consumer re-forward verbatim.
  eventType: string;
  // The exact payload the bridge would have forwarded for this event.
  data: unknown;
  // Identifies the originating flow run (disambiguates multiple runs in one
  // session; also the supersede key for any future terminal-collapse entry).
  flowRunId: string;
}

// ---- Code node context & handler type ---------------------------------

export interface CodeNodeContext {
  signal: AbortSignal; // Flow abort signal; handler should respect it
  cwd: string; // Project root
  logger: (msg: string) => void; // Logs to step card
  setSummary: (text: string) => void; // Sets step summary
  flowName: string; // Name of the containing flow
  stepId: string; // ID of this step
  task: string; // Overall flow task text
}

/**
 * Generic handler type for code nodes.
 * Handler is the default export of a .ts module.
 * Input keys are always strings (template-expanded); output must match declared outputs.
 */
export type CodeNodeHandler<I = Record<string, string>, O = Record<string, string>> = (
  input: I,
  ctx: CodeNodeContext,
) => Promise<O>;

// ---- Validation diagnostic ------------------------------------------------

export interface Diagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
}
