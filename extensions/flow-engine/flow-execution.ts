import type { FlowConfig, FlowStep, AgentStep, ForkStep, ConditionalStep, AgentDecisionStep, AgentLoopDecisionStep, FlowRefStep, TemplateContext, AgentResult, FlowResult, CodeStep } from "./types.js";
import { executeCodeStep } from "./execute-code-step.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandTemplateVariables, spawnAgent, loadContextFiles } from "./execution.js";
import { resolveRouteOutcome } from "./failure.js";
import type { FailureInfo } from "./types.js";
import { resolveModel } from "./model-roles.js";
import { parseResult, hasArtifactElement } from "./result-parser.js";
import { parseFlowYamlFile } from "./flow-parser-yaml.js";
import { raceWithAbort } from "./abort-utils.js";
import { globSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---- Flow cancellation error -----------------------------------------------

/**
 * Thrown when the user cancels a fork prompt (Escape) or the flow's abort
 * signal fires during a UI prompt (Ctrl+X). Caught by runFlow to produce
 * a clean cancellation result distinct from runtime errors.
 */
export class FlowCancelledError extends Error {
  constructor(message = "Flow cancelled by user") {
    super(message);
    this.name = "FlowCancelledError";
  }
}

export interface ForkContext {
  forkId: string;
  question: string;
  answer: string;
  notes?: string;
  decidedBy?: string;  // agent name if auto-decided
}

export interface FlowContext {
  task: string;
  results: Record<string, { fullOutput: string; status: string; summary: string; artifacts: string; files: string }>;
  forks: Record<string, { answer: string; notes?: string }>;
  loopCounters: Record<string, number>;
  loopMaxIterations: Record<string, number>;
  steps: FlowStep[];
  /** Fork context to autowire into the next branch step */
  pendingForkContext?: Map<string, ForkContext>;  // step ID -> fork context
  /**
   * Internal (set by runFlow). Holds the first HARD-fail detail once a node
   * hard-fails; presence signals the scheduler to halt and end with status
   * `error`. Distinct from user abort.
   */
  hardFail?: FailureInfo | null;
  /**
   * Internal (set by runFlow). Trips the run's halt signal so in-flight
   * parallel steps abort cooperatively (reuses the user-abort path).
   */
  requestHalt?: () => void;
}

export interface FlowRunOptions {
  flow: FlowConfig;
  task: string;
  cwd: string;
  authStorage?: any;
  modelRegistry?: any;
  /** Operator's live SessionManager — forked into agents declaring `fork_session`. */
  mainSessionManager?: any;
  extraAgentExtensions?: any[];
  /** Extension-registered custom tool definitions passed to spawned agent sessions. */
  extraCustomTools?: any[];
  /** Extension API handle — threaded into `resolveModel` (event-bus) and
   *  forwarded into `spawnAgent` so subagents share the same handle. */
  pi: ExtensionAPI;
  getAgent: (name: string) => any;  // AgentConfig lookup
  getSkillContent?: (name: string) => string | undefined;
  askUser: (question: string, type: string, options?: string[], extra?: any) => Promise<{ answer: string; notes?: string }>;
  onAgentStarted?: (agentName: string, stepId: string, resolvedModel?: string, extra?: { kind?: string }) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult, extra?: { kind?: string }) => void;
  onToolCall?: (agentName: string, stepId: string, toolName: string, input: any) => void;
  onToolResult?: (agentName: string, stepId: string, toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (agentName: string, stepId: string, text: string) => void;
  onThinkingText?: (agentName: string, stepId: string, text: string) => void;
  onExtensionUIRequest?: (agentName: string, request: any, respond: (response: any) => void) => void;
  onLoopIteration?: (stepId: string, iteration: number, maxIterations: number, loopTarget?: string) => void;
  isAutonomous?: () => boolean;
  onAutoDecision?: (forkId: string, agentName: string, chosenBranch: string, targetStepId: string) => void;
  onNotify?: (message: string) => void;
  signal?: AbortSignal;
}

// ---- Segment types ---------------------------------------------------------

type Segment =
  | { type: "dag"; steps: AgentStep[]; activeSteps?: Set<string> }
  | { type: "separator"; step: FlowStep };

// ---- Public API ------------------------------------------------------------

export async function runFlow(options: FlowRunOptions): Promise<FlowResult> {
  const { flow, task, cwd } = options;
  const startTime = Date.now();

  // Build loopMaxIterations map from flow steps
  const loopMaxIterations: Record<string, number> = {};
  for (const step of flow.steps) {
    if (step.stepType === "agent-loop-decision") {
      loopMaxIterations[step.id] = step.max_iterations;
    }
  }

  const ctx: FlowContext = {
    task,
    results: {},
    forks: {},
    loopCounters: {},
    loopMaxIterations,
    steps: flow.steps,
    pendingForkContext: new Map(),
    hardFail: null,
  };

  // Hard-fail halt reuses the user-abort path (abort-utils) with a DISTINCT
  // terminal status (`error` vs user abort's `aborted`). A node hard-fail
  // trips `haltController`, unwinding in-flight parallel steps the same way a
  // user abort does. The user's own signal is forwarded into the controller so
  // both paths share one signal downstream. See node-failure-model D6.
  const userSignal = options.signal;
  const haltController = new AbortController();
  if (userSignal) {
    if (userSignal.aborted) haltController.abort();
    else userSignal.addEventListener("abort", () => haltController.abort(), { once: true });
  }
  ctx.requestHalt = () => { if (!haltController.signal.aborted) haltController.abort(); };
  const effectiveOptions: FlowRunOptions = { ...options, signal: haltController.signal };

  const segments = splitIntoSegments(flow.steps);
  const maxConcurrent = flow.max_concurrent ?? 4;
  let lastResult: AgentResult | null = null;
  let segmentIndex = 0;

  let cancelled = false;

  try {
    while (segmentIndex < segments.length) {
      // Check abort before processing each segment

      const segment = segments[segmentIndex];

      if (segment.type === "dag") {

        const dagResult = await runDagSegment(segment.steps, maxConcurrent, ctx, effectiveOptions, segment.activeSteps);
        if (dagResult.lastResult) lastResult = dagResult.lastResult;

        // A node hard-failed (or soft-failed with no on_error): halt the flow.
        if (ctx.hardFail) break;

        // Handle routing from on_complete / on_error within the DAG
        if (dagResult.routeToStepId) {
          const targetIdx = findSegmentIndex(segments, dagResult.routeToStepId);
          if (targetIdx >= 0) {
            const targetSeg = segments[targetIdx];
            if (targetSeg.type === "dag") {
              targetSeg.activeSteps = computeActiveSteps(targetSeg.steps, dagResult.routeToStepId);
            }
            segmentIndex = targetIdx;
            continue;
          }
        }
        segmentIndex++;
      } else {
        // Separator step (fork, conditional, agent-decision, flow-ref)

        const stepResult = await executeStep(segment.step, ctx, effectiveOptions);

        if (stepResult.agentResult) {
          lastResult = stepResult.agentResult;
          storeResult(ctx, segment.step.id, stepResult.agentResult);
          // A separator node that hard-fails (e.g. a decision agent hits a
          // terminal API error, or a flow-ref sub-flow hard-failed) halts.
          if (stepResult.agentResult.outcome === "hard" && !ctx.hardFail) {
            ctx.hardFail = stepResult.agentResult.failureInfo
              ?? { outcome: "hard", message: stepResult.agentResult.output || "Hard failure", source: "separator_hard_fail" };
          }
        }
        if (ctx.hardFail) break;

        // Handle routing: jump to target step's segment
        if (stepResult.nextStepId) {
          const targetIdx = findSegmentIndex(segments, stepResult.nextStepId);
          if (targetIdx >= 0) {
            // Compute active steps for branch exclusivity
            const targetSeg = segments[targetIdx];
            if (targetSeg.type === "dag") {
              targetSeg.activeSteps = computeActiveSteps(targetSeg.steps, stepResult.nextStepId);
            }
            segmentIndex = targetIdx;
            continue;
          }
        }

        segmentIndex++;
      }
    }
  } catch (err) {
    if (err instanceof FlowCancelledError) {
      cancelled = true;
    } else {
      throw err; // Re-throw unexpected errors
    }
  }

  // A HARD failure halts the flow with status `error` and surfaces the reason.
  // Checked before the cancellation path because a hard-fail trips the same
  // abort race (so `cancelled` may also be set) but is NOT a user cancellation.
  if (ctx.hardFail) {
    const hf = ctx.hardFail;
    const hardResult: AgentResult = {
      success: false,
      output: hf.message,
      stderr: "",
      exitCode: null,
      result: { status: "error" as const, summary: hf.message, files: [], artifacts: "" },
      toolCalls: [],
      duration: Date.now() - startTime,
      tokens: { input: 0, output: 0 },
      outcome: "hard",
      failureInfo: hf,
    };
    return {
      lastResult: hardResult,
      results: { ...ctx.results },
      forks: { ...ctx.forks },
      flowName: flow.name,
      stepCount: Object.keys(ctx.results).length,
      totalDuration: Date.now() - startTime,
      status: "error",
    };
  }

  // If cancelled, produce a clean cancellation result
  if (cancelled) {
    const cancelResult: AgentResult = {
      success: false,
      output: "Flow cancelled by user",
      stderr: "",
      exitCode: null,
      result: { status: "error" as const, summary: "Cancelled by user", files: [], artifacts: "" },
      toolCalls: [],
      duration: Date.now() - startTime,
      tokens: { input: 0, output: 0 },
    };

    return {
      lastResult: cancelResult,
      results: { ...ctx.results },
      forks: { ...ctx.forks },
      flowName: flow.name,
      stepCount: Object.keys(ctx.results).length,
      totalDuration: Date.now() - startTime,
    };
  }

  // If aborted, mark any agents that didn't complete as aborted
  if (options.signal?.aborted) {
    const allAgentNames = new Set<string>();
    for (const step of flow.steps) {
      if (step.stepType === "agent") allAgentNames.add(step.agent);
    }
    for (const name of allAgentNames) {
      if (!ctx.results[name]) {
        ctx.results[name] = {
          fullOutput: "",
          status: "aborted",
          summary: "Aborted by user",
          artifacts: "",
          files: "",
        };
      }
    }
  }

  const lastOutput = lastResult?.output ?? "";
  const finalResult = lastResult ?? { success: true, output: lastOutput, stderr: "", exitCode: 0, result: parseResult(lastOutput), toolCalls: [], duration: 0, tokens: { input: 0, output: 0 } };

  return {
    lastResult: finalResult,
    results: { ...ctx.results },
    forks: { ...ctx.forks },
    flowName: flow.name,
    stepCount: Object.keys(ctx.results).length,
    totalDuration: Date.now() - startTime,
  };
}

// ---- Segment splitting -----------------------------------------------------

function splitIntoSegments(steps: FlowStep[]): Segment[] {
  const segments: Segment[] = [];
  let currentAgents: AgentStep[] = [];

  for (const step of steps) {
    if (step.stepType === "agent") {
      currentAgents.push(step as AgentStep);
    } else {
      if (currentAgents.length > 0) {
        segments.push({ type: "dag", steps: currentAgents });
        currentAgents = [];
      }
      segments.push({ type: "separator", step });
    }
  }

  if (currentAgents.length > 0) {
    segments.push({ type: "dag", steps: currentAgents });
  }

  return segments;
}

function findSegmentIndex(segments: Segment[], stepId: string): number {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === "dag") {
      if (seg.steps.some(s => s.id === stepId)) return i;
    } else {
      if (seg.step.id === stepId) return i;
    }
  }
  return -1;
}

// ---- DAG segment execution -------------------------------------------------

interface DagSegmentResult {
  lastResult: AgentResult | null;
  /** If set, the DAG wants to route to this step (may be inside or outside the segment) */
  routeToStepId?: string;
}

async function runDagSegment(
  steps: AgentStep[],
  maxConcurrent: number,
  ctx: FlowContext,
  options: FlowRunOptions,
  activeSteps?: Set<string>,
): Promise<DagSegmentResult> {
  const completed = new Set<string>();
  let lastResult: AgentResult | null = null;
  let waveNumber = 0;
  let lastSnapshot = "";
  let deadlockCount = 0;

  // Cross-segment blockedBy: deps referencing steps outside this DAG segment
  // are already satisfied (the preceding separator/segment completed before us).
  const segmentStepIds = new Set(steps.map(s => s.id));

  // If activeSteps is set (branch exclusivity), skip inactive steps immediately
  if (activeSteps) {
    for (const step of steps) {
      if (!activeSteps.has(step.id)) {
        completed.add(step.id);
        // Store synthetic "skipped" result so blockedBy refs auto-satisfy
        const skippedResult = { fullOutput: "", status: "skipped" as const, summary: "", artifacts: "", files: "" };
        ctx.results[step.id] = skippedResult;
        // Don't emit events for skipped agents — they stay "pending" in the dashboard
      }
    }
  }

  while (completed.size < steps.length) {
    // Check abort before dispatching each wave
    if (options.signal?.aborted) break;

    waveNumber++;

    // Find unblocked steps within this segment
    // Deps outside this segment are treated as satisfied (cross-segment ordering)
    const unblocked = steps.filter(s => {
      if (completed.has(s.id)) return false;
      if (!s.blockedBy) return true;
      return s.blockedBy.every(dep => completed.has(dep) || !segmentStepIds.has(dep));
    });

    // Deadlock detection
    const snapshot = unblocked.map(s => s.id).sort().join(",");
    if (snapshot === lastSnapshot) {
      deadlockCount++;
      if (deadlockCount >= 3) {
        return { lastResult: { success: false, output: "Deadlock detected in DAG segment", stderr: "", exitCode: null, result: parseResult(""), toolCalls: [], duration: 0, tokens: { input: 0, output: 0 } } };
      }
    } else {
      deadlockCount = 0;
      lastSnapshot = snapshot;
    }

    if (unblocked.length === 0 && completed.size < steps.length) break;

    // Dispatch up to maxConcurrent
    const batch: AgentStep[] = [];
    for (const step of unblocked) {
      if (batch.length >= maxConcurrent) break;
      batch.push(step);
    }

    // Execute batch in parallel.
    //
    // The Promise.all is wrapped in `raceWithAbort` so user abort unwinds the
    // parent loop within a microtask of the signal firing, instead of waiting
    // for every in-flight child to observe `options.signal?.aborted` at its
    // own iteration boundary. Pending children still call `session.abort()`
    // via their existing listener and clean up in the background; the
    // catch-block below synthesises `cancelled: true` results for any step
    // that hadn't returned yet so observers (TUI, dashboard) render accurate
    // per-agent state.
    //
    // See change: fix-pi-flows-end-to-end (Group 3, tasks 3.1 + 3.3).
    //
    // Early HARD-fail detection: as soon as any step in the wave resolves with
    // a `hard` outcome (terminal API error, FlowHardError, or a soft failure
    // with no on_error escalated to hard), we record the reason and trip
    // `ctx.requestHalt()`, which aborts the run signal and unwinds the
    // in-flight siblings via the same race below. Correctness does NOT depend
    // on the race winning: the hard-failing step's result is stored here, and
    // runFlow re-checks `ctx.hardFail` after the segment regardless of timing.
    let results: (AgentResult | null)[];
    try {
      results = await raceWithAbort(
        Promise.all(batch.map(async (step) => {
          const r = await executeAgentStep(step, ctx, options);
          if (r && !ctx.hardFail && resolveRouteOutcome(r, step.on_error) === "hard") {
            completed.add(step.id);
            lastResult = r;
            storeResult(ctx, step.id, r);
            ctx.hardFail = r.failureInfo
              ?? { outcome: "hard", message: r.output || "Hard failure", source: "node_hard_fail" };
            ctx.requestHalt?.();
          }
          return r;
        })),
        options.signal,
      );
    } catch (err) {
      if (err instanceof FlowCancelledError) {
        // Synthesize cancelled results for every step that hadn't completed
        // before the race tripped. Children may still resolve later; their
        // results are discarded by the parent.
        for (const step of batch) {
          if (!completed.has(step.id)) {
            completed.add(step.id);
            const cancelledResult: AgentResult = {
              success: false,
              output: "",
              stderr: "Cancelled by user",
              exitCode: null,
              result: parseResult(""),
              toolCalls: [],
              duration: 0,
              tokens: { input: 0, output: 0 },
              cancelled: true,
            };
            lastResult = cancelledResult;
            storeResult(ctx, step.id, cancelledResult);
          }
        }
        throw err; // Propagate up to runFlow's catch which produces clean FlowResult
      }
      throw err;
    }

    // A hard-fail was detected during the wave (or the race tripped): stop
    // scheduling. runFlow inspects ctx.hardFail and ends the flow `error`.
    if (ctx.hardFail) return { lastResult };

    // Store results and check for routing
    for (let i = 0; i < batch.length; i++) {
      const step = batch[i];
      const result = results[i];
      completed.add(step.id);
      if (result) {
        lastResult = result;
        storeResult(ctx, step.id, result);

        // Outcome-aware routing (node-failure-model): success -> on_complete,
        // soft -> on_error, hard / soft-without-on_error -> halt the flow.
        const outcome = resolveRouteOutcome(result, step.on_error);
        if (outcome === "hard") {
          ctx.hardFail = result.failureInfo
            ?? { outcome: "hard", message: result.output || "Hard failure", source: "node_hard_fail" };
          ctx.requestHalt?.();
          return { lastResult };
        }
        const routeTarget = outcome === "success" ? step.on_complete : step.on_error;
        if (routeTarget) {
          const targetInSegment = steps.some(s => s.id === routeTarget);
          if (targetInSegment) {
            // Route within this DAG: narrow active steps to those reachable from target
            const reachable = computeActiveSteps(steps, routeTarget);
            for (const s of steps) {
              if (!reachable.has(s.id) && !completed.has(s.id)) {
                completed.add(s.id);
                ctx.results[s.id] = { fullOutput: "", status: "skipped", summary: "", artifacts: "", files: "" };
              }
            }
          } else {
            // Route outside this DAG: skip all remaining steps, signal the main loop
            for (const s of steps) {
              if (!completed.has(s.id)) {
                completed.add(s.id);
                ctx.results[s.id] = { fullOutput: "", status: "skipped", summary: "", artifacts: "", files: "" };
              }
            }
            return { lastResult, routeToStepId: routeTarget };
          }
        }
      }
    }
  }

  return { lastResult };
}

// ---- Step execution --------------------------------------------------------

interface StepResult {
  agentResult?: AgentResult;
  nextStepId?: string;
}

async function executeStep(step: FlowStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  switch (step.stepType) {
    case "agent": return executeAgentStepWithRouting(step, ctx, options);
    case "code": return executeCodeStepWithRouting(step, ctx, options);
    case "fork": return executeForkStep(step, ctx, options);
    case "conditional": return executeConditionalStep(step, ctx, options);
    case "agent-decision": return executeAgentDecisionStep(step, ctx, options);
    case "agent-loop-decision": return executeAgentLoopDecisionStep(step, ctx, options);
    case "flow-ref": return executeFlowRefStep(step, ctx, options);
  }
}

async function executeAgentStepWithRouting(step: AgentStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const result = await executeAgentStep(step, ctx, options);
  if (!result) return {};

  // Outcome-aware routing: success -> on_complete, soft -> on_error.
  // hard (or soft-without-on_error) leaves nextStepId undefined; the main loop
  // detects result.outcome === "hard" and halts the flow.
  const outcome = resolveRouteOutcome(result, step.on_error);
  const nextStepId = outcome === "success" ? step.on_complete : outcome === "soft" ? step.on_error : undefined;
  return { agentResult: result, nextStepId };
}

async function executeCodeStepWithRouting(step: CodeStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const result = await executeCodeStep(step, ctx, options, options.flow.name);
  // Outcome-aware routing: success -> on_complete, soft -> on_error.
  // A `hard` outcome (FlowHardError) or a soft failure with no on_error escalates
  // to a flow halt. Code nodes run as separator steps, so the runFlow separator
  // branch halts on `agentResult.outcome === "hard"`: stamp that here on escalation.
  const outcome = resolveRouteOutcome(result, step.on_error);
  if (outcome === "hard") {
    result.outcome = "hard";
    result.failureInfo = {
      outcome: "hard",
      message: result.failureInfo?.message ?? result.output ?? "Hard failure",
      source: result.failureInfo?.source ?? "code_hard_fail",
    };
    return { agentResult: result, nextStepId: undefined };
  }
  const nextStepId = outcome === "success" ? step.on_complete : step.on_error;
  return { agentResult: result, nextStepId };
}

/**
 * Filter extraCustomTools to only include tools declared in the agent's `tools` list.
 * Built-in tools (read, write, bash, etc.) are handled by TOOL_FACTORIES in execution.ts
 * and are never part of extraCustomTools, so this filter only affects extension tools.
 */
function filterExtensionTools(allTools: any[] | undefined, agentTools: string[]): any[] {
  if (!allTools || allTools.length === 0) return [];
  return allTools.filter(t => agentTools.includes(t.name));
}

async function executeAgentStep(step: AgentStep, ctx: FlowContext, options: FlowRunOptions): Promise<AgentResult | null> {
  const agentConfig = options.getAgent(step.agent);
  if (!agentConfig) {
    const errorResult: AgentResult = {
      success: false,
      output: `Agent not found: "${step.agent}". Check that the agent exists in the discovered catalog.`,
      stderr: `Agent "${step.agent}" not found in discovery catalog`,
      exitCode: 1,
      result: parseResult(""),
      toolCalls: [],
      duration: 0,
      tokens: { input: 0, output: 0 },
    };
    options.onAgentStarted?.(step.agent, step.id);
    options.onAgentComplete?.(step.agent, step.id, errorResult);
    return errorResult;
  }

  // Resolve model early so it's available for onAgentStarted observers
  let resolvedModelId: string | undefined;
  try {
    const { modelId } = resolveModel(options.pi, agentConfig.model, agentConfig.thinking);
    resolvedModelId = modelId;
  } catch {
    // Model resolution failed — will be caught again inside spawnAgent
  }

  options.onAgentStarted?.(step.agent, step.id, resolvedModelId);

  // Resolve step inputs at dispatch time.
  // File inputs (file:// prefix) are read from disk. Their content is stored with unique
  // sentinel placeholders so that expandTemplateVariables never sees the raw file content
  // (which could contain ${{}} syntax that would be incorrectly expanded).
  const resolvedInputs: Record<string, string> = {};
  const fileInputs: Record<string, string> = {};  // sentinel → file content
  if (step.inputs) {
    const resolveCtx: TemplateContext = {
      task: ctx.task,
      inputs: {},
      results: ctx.results,
      loopCounters: ctx.loopCounters,
      loopMaxIterations: ctx.loopMaxIterations,
    };
    for (const [name, expr] of Object.entries(step.inputs)) {
      const resolved = expandTemplateVariables(expr, resolveCtx);
      if (resolved.startsWith("file://")) {
        const filePath = resolved.slice(7);
        if (!filePath) {
          return {
            success: false,
            output: `File input "${name}" resolved to empty path (was: ${expr})`,
            stderr: `file:// input "${name}" has empty path after template expansion`,
            exitCode: 1,
            result: { status: "error" as const, files: [], artifacts: "", summary: "" },
            toolCalls: [],
            duration: 0,
            tokens: { input: 0, output: 0 },
          };
        }
        const absPath = resolve(options.cwd, filePath);
        if (!existsSync(absPath)) {
          return {
            success: false,
            output: `File input "${name}" not found: ${absPath} (resolved from: ${expr})`,
            stderr: `file:// input "${name}" references missing file: ${absPath}`,
            exitCode: 1,
            result: { status: "error" as const, files: [], artifacts: "", summary: "" },
            toolCalls: [],
            duration: 0,
            tokens: { input: 0, output: 0 },
          };
        }
        const content = readFileSync(absPath, "utf-8");
        // Use a sentinel placeholder that won't appear in normal text or be matched by template expansion
        const sentinel = `__FILE_INPUT_${name}_${Date.now()}__`;
        resolvedInputs[name] = sentinel;
        fileInputs[sentinel] = content;
      } else {
        resolvedInputs[name] = resolved;
      }
    }
  }

  const templateCtx: TemplateContext = {
    task: ctx.task,
    inputs: resolvedInputs,
    results: ctx.results,
    loopCounters: ctx.loopCounters,
    loopMaxIterations: ctx.loopMaxIterations,
  };

  // Determine user message: step task override or fallback to flow task
  const userTask = step.task ? expandTemplateVariables(step.task, templateCtx) : ctx.task;

  // Get skill contents
  const skillContents = new Map<string, string>();
  if (agentConfig.skills) {
    for (const skill of agentConfig.skills) {
      const content = options.getSkillContent?.(skill);
      if (content) skillContents.set(skill, content);
    }
  }

  // Autowire fork context if this step was branched-to from a fork
  const preambleSections: string[] = [];

  // Inject declared context files (pre-read into the system prompt). Missing or
  // unreadable files are skipped with a diagnostic, not fatal.
  if (agentConfig.context_files) {
    const { sections, missing, unreadable } = loadContextFiles(options.cwd, agentConfig.context_files);
    preambleSections.push(...sections);
    for (const f of missing) options.onNotify?.(`Context file not found for "${step.agent}": ${f}`);
    for (const f of unreadable) options.onNotify?.(`Context file unreadable for "${step.agent}": ${f}`);
  }

  const forkCtx = ctx.pendingForkContext?.get(step.id);
  if (forkCtx) {
    const header = forkCtx.decidedBy ? "Auto Decision" : "User Decision";
    let section = `## ${header}: ${forkCtx.forkId}\nQuestion: ${forkCtx.question}\nSelected: ${forkCtx.answer}`;
    if (forkCtx.notes) section += `\nNotes: ${forkCtx.notes}`;
    if (forkCtx.decidedBy) section += `\nDecided by: ${forkCtx.decidedBy}`;
    preambleSections.push(section);
    // Remove so it's only injected into the immediate branch step
    ctx.pendingForkContext!.delete(step.id);
  }

  const result = await spawnAgent({
    agent: agentConfig,
    task: userTask,
    templateContext: templateCtx,
    skillContents,
    preambleSections,
    fileInputs: Object.keys(fileInputs).length > 0 ? fileInputs : undefined,
    pi: options.pi,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    mainSessionManager: options.mainSessionManager,
    extraAgentExtensions: options.extraAgentExtensions,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, agentConfig.tools),
    onToolCall: (name, input) => options.onToolCall?.(step.agent, step.id, name, input),
    onToolResult: (name, output, err) => options.onToolResult?.(step.agent, step.id, name, output, err),
    onAssistantText: (text) => options.onAssistantText?.(step.agent, step.id, text),
    onThinkingText: (text) => options.onThinkingText?.(step.agent, step.id, text),
    onExtensionUIRequest: options.onExtensionUIRequest
      ? (request, respond) => options.onExtensionUIRequest!(step.agent, request, respond)
      : undefined,
    signal: options.signal,
    resolvedModelId,
  });

  options.onAgentComplete?.(step.agent, step.id, result);
  return result;
}

/**
 * Spawn the fork's decision agent to choose a branch.
 * Used by autonomous mode, __auto_decide__, and __custom_decide__ paths.
 * When the fork has no agent: field, uses the built-in `flow-decision` agent.
 */
async function spawnForkDecisionAgent(
  step: ForkStep,
  ctx: FlowContext,
  options: FlowRunOptions,
  customText?: string,
): Promise<StepResult> {
  const agentConfig = step.agent
    ? options.getAgent(step.agent)
    : options.getAgent("flow-decision");
  if (!agentConfig) {
    return {
      agentResult: {
        success: false,
        output: `Decision agent not found: "${step.agent || 'flow-decision'}". Ensure the agent exists in the catalog.`,
        stderr: `Decision agent "${step.agent || 'flow-decision'}" not found`,
        exitCode: 1,
        result: { status: "error" as const, files: [], artifacts: "", summary: "" },
        toolCalls: [],
        duration: 0,
        tokens: { input: 0, output: 0 },
      },
    };
  }

  const branchNames = Object.keys(step.branches);
  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  };

  let decisionTask = step.task
    ? expandTemplateVariables(step.task, templateCtx)
    : `The user was asked: "${step.question}"\nOptions: ${step.options.join(", ")}\nChoose the best option.`;

  // Enhance task with custom freetext context when provided
  if (customText) {
    decisionTask += `\n\nThe user typed a custom answer instead of picking an option: "${customText}"\nBased on their intent, choose the closest matching branch.`;
  }

  const agentName = step.agent || agentConfig.name;
  options.onAgentStarted?.(agentName, step.id);

  const result = await spawnAgent({
    agent: agentConfig,
    task: decisionTask,
    templateContext: templateCtx,
    pi: options.pi,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraAgentExtensions: options.extraAgentExtensions,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, agentConfig.tools),
    decisionBranches: branchNames,
    onToolCall: (name, input) => options.onToolCall?.(agentName, step.id, name, input),
    onToolResult: (name, output, err) => options.onToolResult?.(agentName, step.id, name, output, err),
    onAssistantText: (text) => options.onAssistantText?.(agentName, step.id, text),
    onThinkingText: (text) => options.onThinkingText?.(agentName, step.id, text),
    signal: options.signal,
  });

  options.onAgentComplete?.(agentName, step.id, result);

  const branch = result.finishParams?.branch;
  if (branch && step.branches[branch]) {
    ctx.forks[step.id] = { answer: branch, notes: customText };
    storeForkContext(ctx, step, step.branches[branch], branch, customText, step.agent);
    options.onAutoDecision?.(step.id, step.agent || agentConfig.name, branch, step.branches[branch]);
    return { nextStepId: step.branches[branch], agentResult: result };
  }

  // Fallback: first branch if agent fails
  const firstKey = Object.keys(step.branches)[0];
  ctx.forks[step.id] = { answer: firstKey, notes: customText };
  storeForkContext(ctx, step, step.branches[firstKey], firstKey, customText, step.agent);
  return { nextStepId: step.branches[firstKey], agentResult: result };
}

async function executeForkStep(step: ForkStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const expandedQuestion = expandTemplateVariables(step.question, {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  });

  // ── Autonomous mode: auto-decide via agent (named agent, or built-in flow-decision) ──
  if (options.isAutonomous?.()) {
    return spawnForkDecisionAgent(step, ctx, options);
  }

  // Signal that the fork step is active (waiting for user input)
  const forkAgentName = step.agent || "fork";
  options.onAgentStarted?.(forkAgentName, step.id);

  const extra: Record<string, boolean | Record<string, string>> = {};
  if (step.multiSelect) extra.multiSelect = true;
  if (step.allowCustom) extra.allowCustom = true;
  // Pass branch mapping and agent info for UI enhancement
  if (step.branches) extra.branches = step.branches;
  if (step.agent) extra.hasAutoAgent = true;

  const response = await options.askUser(expandedQuestion, "select", step.options, extra);

  const makeForkResult = (summary: string): AgentResult => ({
    success: true, output: summary, stderr: "", exitCode: 0,
    result: { status: "complete" as const, files: [], artifacts: "", summary },
    toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
  });

  // Handle auto-decide: user chose to let the agent decide this fork
  if (response.answer === "__auto_decide__" && step.agent) {
    options.onAgentComplete?.(forkAgentName, step.id, makeForkResult("Auto-decide"));
    return spawnForkDecisionAgent(step, ctx, options);
  }

  // Handle custom-decide: user typed freetext via "Other (describe)"
  if (response.answer === "__custom_decide__" && step.agent) {
    options.onAgentComplete?.(forkAgentName, step.id, makeForkResult(response.notes || "Custom"));
    return spawnForkDecisionAgent(step, ctx, options, response.notes);
  }

  // User selected an option directly
  options.onAgentComplete?.(forkAgentName, step.id, makeForkResult(`Selected: ${response.answer}`));

  ctx.forks[step.id] = response;

  // Multi-select: execute all selected branches sequentially
  if (step.multiSelect && Array.isArray(response.answer)) {
    let lastResult: StepResult = {};
    const selectedOptions = response.answer as unknown as string[];
    for (const ans of selectedOptions) {
      const branchStepId = step.branches[ans];
      if (!branchStepId) continue;
      // Autowire fork context for each branch (with all selected options)
      storeForkContext(ctx, step, branchStepId, selectedOptions.join(", "), response.notes);
      const branchStep = ctx.steps.find(s => s.id === branchStepId);
      if (branchStep) {
        lastResult = await executeStep(branchStep, ctx, options);
        if (lastResult.agentResult) {
          storeResult(ctx, branchStep.id, lastResult.agentResult);
        }
      }
    }
    return {};
  }

  const nextStepId = step.branches[response.answer];

  // Store fork context for autowiring into the branch step
  if (nextStepId) {
    storeForkContext(ctx, step, nextStepId, response.answer, response.notes);
  }

  return { nextStepId };
}

/** Store fork context so the branch step receives it as autowired context */
function storeForkContext(
  ctx: FlowContext,
  step: ForkStep,
  targetStepId: string,
  answer: string,
  notes?: string,
  decidedBy?: string,
): void {
  if (!ctx.pendingForkContext) ctx.pendingForkContext = new Map();
  ctx.pendingForkContext.set(targetStepId, {
    forkId: step.id,
    question: step.question,
    answer,
    notes,
    decidedBy,
  });
}

async function executeConditionalStep(step: ConditionalStep, ctx: FlowContext, _options: FlowRunOptions): Promise<StepResult> {
  // Parse check field: "step-id.field" or just "step-id"
  const dotIdx = step.check.lastIndexOf(".");
  const stepId = dotIdx > 0 ? step.check.slice(0, dotIdx) : step.check;
  const field = dotIdx > 0 ? step.check.slice(dotIdx + 1) : "artifacts";

  const result = ctx.results[stepId];
  if (!result) {
    return { nextStepId: step.absent };
  }

  // Check if the resolved field is non-empty.
  // Standard fields resolve directly; any other key resolves from typedOutputs
  // (merged into result map via storeResult) before falling back to fullOutput.
  const target = field === "artifacts" ? result.artifacts
    : field === "summary" ? result.summary
    : field === "files" ? result.files
    : field === "status" ? result.status
    : (field in result ? (result as Record<string, string>)[field] : result.fullOutput);
  const exists = (target ?? "").trim().length > 0;
  return { nextStepId: exists ? step.present : step.absent };
}

async function executeAgentDecisionStep(step: AgentDecisionStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const agentConfig = options.getAgent(step.agent);
  if (!agentConfig) return {};

  const decisionConfig = { ...agentConfig };
  const branchNames = Object.keys(step.branches);

  const decisionTask = expandTemplateVariables(step.task, {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  });

  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  };

  const skillContents = new Map<string, string>();
  if (decisionConfig.skills) {
    for (const skill of decisionConfig.skills) {
      const content = options.getSkillContent?.(skill);
      if (content) skillContents.set(skill, content);
    }
  }
  options.onAgentStarted?.(step.agent, step.id);

  const result = await spawnAgent({
    agent: decisionConfig,
    task: decisionTask,
    templateContext: templateCtx,
    skillContents,
    pi: options.pi,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraAgentExtensions: options.extraAgentExtensions,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, decisionConfig.tools),
    decisionBranches: branchNames,
    onToolCall: (name, input) => options.onToolCall?.(step.agent, step.id, name, input),
    onToolResult: (name, output, err) => options.onToolResult?.(step.agent, step.id, name, output, err),
    onAssistantText: (text) => options.onAssistantText?.(step.agent, step.id, text),
    onThinkingText: (text) => options.onThinkingText?.(step.agent, step.id, text),
    signal: options.signal,
  });

  options.onAgentComplete?.(step.agent, step.id, result);

  // Route via finish tool's branch parameter
  const branch = result.finishParams?.branch;
  if (branch && step.branches[branch]) {
    return { nextStepId: step.branches[branch], agentResult: result };
  }

  // Fallback: first branch when agent fails or branch missing
  const firstBranch = Object.values(step.branches)[0];
  return { nextStepId: firstBranch, agentResult: result };
}

async function executeAgentLoopDecisionStep(step: AgentLoopDecisionStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  // 1-based iteration that stays aligned between the loop body and this
  // decision step. The counter is initialized lazily to 1 (the first body pass
  // already observed 1 via expandTemplateVariables' `?? 1` default) and is
  // incremented on loop-back below, so body pass N and decision pass N agree.
  const iteration = ctx.loopCounters[step.id] ?? 1;
  ctx.loopCounters[step.id] = iteration;

  // Emit loop iteration event — resolve loop_target step ID to agent name
  // (dashboard cards are keyed by agent name, not step ID)
  const loopTargetStep = ctx.steps.find(s => s.id === step.loop_target);
  const loopTargetAgent = loopTargetStep?.stepType === "agent" ? (loopTargetStep as AgentStep).agent : step.loop_target;
  options.onLoopIteration?.(step.id, iteration, step.max_iterations, loopTargetAgent);

  // Safety cap: force exit when max_iterations exceeded
  if (iteration > step.max_iterations) {
    return { nextStepId: step.exit_target };
  }

  const agentConfig = options.getAgent(step.agent);
  if (!agentConfig) return { nextStepId: step.exit_target };

  const decisionConfig = { ...agentConfig };

  const decisionTask = expandTemplateVariables(step.task, {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  }) + `\n\nThis is iteration ${iteration} of ${step.max_iterations}.`;

  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  };

  const skillContents = new Map<string, string>();
  if (decisionConfig.skills) {
    for (const skill of decisionConfig.skills) {
      const content = options.getSkillContent?.(skill);
      if (content) skillContents.set(skill, content);
    }
  }
  options.onAgentStarted?.(step.agent, step.id);

  const result = await spawnAgent({
    agent: decisionConfig,
    task: decisionTask,
    templateContext: templateCtx,
    skillContents,
    pi: options.pi,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraAgentExtensions: options.extraAgentExtensions,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, decisionConfig.tools),
    decisionBranches: ["loop", "exit"],
    onToolCall: (name, input) => options.onToolCall?.(step.agent, step.id, name, input),
    onToolResult: (name, output, err) => options.onToolResult?.(step.agent, step.id, name, output, err),
    onAssistantText: (text) => options.onAssistantText?.(step.agent, step.id, text),
    onThinkingText: (text) => options.onThinkingText?.(step.agent, step.id, text),
    signal: options.signal,
  });

  options.onAgentComplete?.(step.agent, step.id, result);

  const branch = result.finishParams?.branch;
  if (branch === "loop") {
    // Advance the counter so the NEXT body pass (and the next decision) see N+1.
    ctx.loopCounters[step.id] = iteration + 1;
    return { nextStepId: step.loop_target, agentResult: result };
  }
  return { nextStepId: step.exit_target, agentResult: result };
}

async function executeFlowRefStep(step: FlowRefStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const expandedPath = expandTemplateVariables(step.path, {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  });

  let flowPaths: string[];
  if (expandedPath.includes("*")) {
    try { flowPaths = globSync(expandedPath) as string[]; } catch { flowPaths = []; }
  } else {
    flowPaths = [expandedPath];
  }

  let lastAgentResult: AgentResult | null = null;
  for (const flowPath of flowPaths) {
    try {
      const subFlow = parseFlowYamlFile(flowPath);
      const flowResult = await runFlow({
        ...options,
        flow: subFlow,
        task: ctx.task,
      });
      lastAgentResult = flowResult.lastResult;
      // Merge sub-flow agent results into parent context (flat merge by step ID)
      for (const [subStepId, subResult] of Object.entries(flowResult.results)) {
        ctx.results[subStepId] = subResult;
      }
      // Also store under flow-ref step ID for backward compatibility
      if (lastAgentResult) {
        storeResult(ctx, step.id, lastAgentResult);
      }
    } catch { /* skip invalid flows */ }
  }

  const outcome = lastAgentResult ? resolveRouteOutcome(lastAgentResult, step.on_error) : "soft";
  const nextStepId = outcome === "success" ? step.on_complete : outcome === "soft" ? step.on_error : undefined;
  return { agentResult: lastAgentResult ?? undefined, nextStepId };
}

// ---- Helpers ---------------------------------------------------------------

function storeResult(ctx: FlowContext, stepId: string, result: AgentResult): void {
  ctx.results[stepId] = {
    fullOutput: result.output,
    status: result.result.status,
    summary: result.result.summary,
    artifacts: result.result.artifacts,
    files: result.result.files.map(f => f.path).join(", "),
    // Merge typed outputs from agent's declared outputs
    ...(result.typedOutputs ?? {}),
  };
}


/**
 * Compute the set of active steps in a DAG segment starting from a root step.
 * Walks the blockedBy graph forward: the root step is active, and any step
 * whose blockedBy includes an active step is also active.
 */
function computeActiveSteps(steps: AgentStep[], rootStepId: string): Set<string> {
  const active = new Set<string>();
  active.add(rootStepId);

  // Iterate until no new steps are added (forward reachability)
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (active.has(step.id)) continue;
      if (step.blockedBy && step.blockedBy.some(dep => active.has(dep))) {
        active.add(step.id);
        changed = true;
      }
    }
  }

  return active;
}
