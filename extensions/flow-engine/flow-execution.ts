import type { FlowConfig, FlowStep, AgentStep, ForkStep, AgentDecisionStep, TemplateContext, AgentResult, FlowResult, CodeStep, CodeDecisionStep, NodeKind, StepResultValue } from "./types.js";
import { executeCodeStep } from "./execute-code-step.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandTemplateVariables, spawnAgent, loadContextFiles } from "./execution.js";
import { resolveRouteOutcome } from "./failure.js";
import type { FailureInfo } from "./types.js";
import { resolveModel } from "./model-roles.js";
import { parseResult, hasArtifactElement } from "./result-parser.js";

import { raceWithAbort } from "./abort-utils.js";
import { readFileSync, existsSync } from "node:fs";
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
  /** Typed flow-level inputs (G6), referenceable as `${{flow.input.<name>}}`. */
  flowInput?: Record<string, unknown>;
  results: Record<string, StepResultValue>;
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
  /** Structured flow-level inputs, validated against `flow.inputs`. */
  flowInput?: Record<string, unknown>;
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
  onAgentStarted?: (agentName: string, stepId: string, resolvedModel?: string, extra?: { nodeKind?: NodeKind; target?: string }) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult, extra?: { nodeKind?: NodeKind; target?: string }) => void;
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

  // Validate structured flow inputs against the declared schema (G6). A missing
  // required input or a type mismatch fails the run start with a diagnostic.
  const inputError = validateFlowInput(flow, options.flowInput);
  if (inputError) {
    const errResult: AgentResult = {
      success: false, output: inputError, stderr: "", exitCode: null,
      result: { status: "error" as const, summary: inputError, files: [], artifacts: "" },
      toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
      outcome: "hard", failureInfo: { outcome: "hard", message: inputError, source: "flow_input_invalid" },
    };
    return { lastResult: errResult, results: {}, forks: {}, flowName: flow.name, stepCount: 0, totalDuration: 0, status: "error" };
  }

  // Build loopMaxIterations map from any decision node that caps a backward
  // (loop) edge. A loop is a *-decision branch pointing to an earlier step.
  const loopMaxIterations: Record<string, number> = {};
  for (const step of flow.steps) {
    const mi = (step as { max_iterations?: number }).max_iterations;
    if (typeof mi === "number") loopMaxIterations[step.id] = mi;
  }

  const ctx: FlowContext = {
    task,
    flowInput: options.flowInput,
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

        // Handle routing from on_error within the DAG (success falls through)
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
        // Separator step (fork, conditional, agent-decision)

        const stepResult = await executeStep(segment.step, ctx, effectiveOptions);

        if (stepResult.agentResult) {
          lastResult = stepResult.agentResult;
          storeResult(ctx, segment.step.id, stepResult.agentResult);
          // A separator node that hard-fails (e.g. a decision agent hits a
          // terminal API error) halts.
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
      status: "aborted",
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
          outputs: {},
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
    status: "success",
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
        const skippedResult = { fullOutput: "", status: "skipped" as const, summary: "", outputs: {} };
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

        // Outcome-aware routing (node-failure-model): success -> fall through
        // (no routing), soft -> on_error, hard / soft-without-on_error -> halt.
        const outcome = resolveRouteOutcome(result, step.on_error);
        if (outcome === "hard") {
          ctx.hardFail = result.failureInfo
            ?? { outcome: "hard", message: result.output || "Hard failure", source: "node_hard_fail" };
          ctx.requestHalt?.();
          return { lastResult };
        }
        const routeTarget = outcome === "soft" ? step.on_error : undefined;
        if (routeTarget) {
          const targetInSegment = steps.some(s => s.id === routeTarget);
          if (targetInSegment) {
            // Route within this DAG: narrow active steps to those reachable from target
            const reachable = computeActiveSteps(steps, routeTarget);
            for (const s of steps) {
              if (!reachable.has(s.id) && !completed.has(s.id)) {
                completed.add(s.id);
                ctx.results[s.id] = { fullOutput: "", status: "skipped", summary: "", outputs: {} };
              }
            }
          } else {
            // Route outside this DAG: skip all remaining steps, signal the main loop
            for (const s of steps) {
              if (!completed.has(s.id)) {
                completed.add(s.id);
                ctx.results[s.id] = { fullOutput: "", status: "skipped", summary: "", outputs: {} };
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
    case "code-decision": return executeCodeDecisionStep(step, ctx, options);
    case "fork": return executeForkStep(step, ctx, options);
    case "agent-decision": return executeAgentDecisionStep(step, ctx, options);
  }
}

// ---- Branch routing (shared by agent-decision and code-decision) -----------

/**
 * True when `targetId` re-enters the node `stepId` (a backward / loop edge).
 * Detected from document order: a branch target at or before the deciding
 * step's position forms a cycle. Forward targets sit strictly after it.
 */
function isBackwardTarget(steps: FlowStep[], stepId: string, targetId: string): boolean {
  const si = steps.findIndex((s) => s.id === stepId);
  const ti = steps.findIndex((s) => s.id === targetId);
  return ti >= 0 && si >= 0 && ti <= si;
}

/**
 * Resolve a chosen branch label to its routing target, applying the unified
 * loop semantics: a backward target increments the node's iteration counter
 * (reused from `loopCounters`) and emits `flow:loop-iteration`. Once the cap
 * (`max_iterations`) is reached the engine forces exit by falling through to
 * the next segment (returns `nextStepId: undefined`) instead of re-entering
 * the loop target. Callers guarantee `branch` is present in `branches`.
 */
function routeDecisionBranch(
  step: { id: string; branches: Record<string, string>; max_iterations?: number },
  ctx: FlowContext,
  options: FlowRunOptions,
  branch: string,
): { nextStepId?: string } {
  const target = step.branches[branch];
  if (!isBackwardTarget(ctx.steps, step.id, target)) {
    return { nextStepId: target };
  }

  // Backward (loop) edge. max_iterations is required by validation; default to
  // the value captured in loopMaxIterations as a backstop.
  const max = step.max_iterations ?? ctx.loopMaxIterations[step.id];
  const taken = ctx.loopCounters[step.id] ?? 0;
  if (max !== undefined && taken >= max) {
    // Cap reached: stop looping, force exit (fall through to the next segment).
    return { nextStepId: undefined };
  }
  const iteration = taken + 1;
  ctx.loopCounters[step.id] = iteration;

  // Dashboard cards are keyed by agent name; resolve the loop target's name.
  const loopTargetStep = ctx.steps.find((s) => s.id === target);
  const loopTargetAgent = loopTargetStep?.stepType === "agent" ? (loopTargetStep as AgentStep).agent : target;
  options.onLoopIteration?.(step.id, iteration, max ?? 0, loopTargetAgent);

  return { nextStepId: target };
}

async function executeAgentStepWithRouting(step: AgentStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const result = await executeAgentStep(step, ctx, options);
  if (!result) return {};

  // Outcome-aware routing: success -> fall through (no routing), soft -> on_error.
  // hard (or soft-without-on_error) leaves nextStepId undefined; the main loop
  // detects result.outcome === "hard" and halts the flow.
  const outcome = resolveRouteOutcome(result, step.on_error);
  const nextStepId = outcome === "soft" ? step.on_error : undefined;
  return { agentResult: result, nextStepId };
}

async function executeCodeStepWithRouting(step: CodeStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const result = await executeCodeStep(step, ctx, options, options.flow.name, options.flow.source);
  // Outcome-aware routing: success -> fall through (no routing), soft -> on_error.
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
  const nextStepId = outcome === "soft" ? step.on_error : undefined;
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
    options.onAgentStarted?.(step.agent, step.id, undefined, { nodeKind: "agent" });
    options.onAgentComplete?.(step.agent, step.id, errorResult, { nodeKind: "agent" });
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

  options.onAgentStarted?.(step.agent, step.id, resolvedModelId, { nodeKind: "agent" });

  // Resolve step inputs at dispatch time via plain template expansion (strings).
  // File-backed data is passed as a PATH and read just-in-time by the agent's
  // `read` tool — engine-side `file://` injection was removed
  // (change: flow-typed-io-and-run-state).
  const resolvedInputs: Record<string, string> = {};
  if (step.inputs) {
    const resolveCtx: TemplateContext = {
      task: ctx.task,
      inputs: {},
      results: ctx.results,
      loopCounters: ctx.loopCounters,
      loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
    };
    for (const [name, expr] of Object.entries(step.inputs)) {
      resolvedInputs[name] = expandTemplateVariables(expr, resolveCtx);
    }
  }

  const templateCtx: TemplateContext = {
    task: ctx.task,
    inputs: resolvedInputs,
    results: ctx.results,
    loopCounters: ctx.loopCounters,
    loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
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

  options.onAgentComplete?.(step.agent, step.id, result, { nodeKind: "agent" });
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
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  };

  let decisionTask = step.task
    ? expandTemplateVariables(step.task, templateCtx)
    : `The user was asked: "${step.question}"\nOptions: ${step.options.join(", ")}\nChoose the best option.`;

  // Enhance task with custom freetext context when provided
  if (customText) {
    decisionTask += `\n\nThe user typed a custom answer instead of picking an option: "${customText}"\nBased on their intent, choose the closest matching branch.`;
  }

  const agentName = step.agent || agentConfig.name;
  options.onAgentStarted?.(agentName, step.id, undefined, { nodeKind: "fork" });

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

  options.onAgentComplete?.(agentName, step.id, result, { nodeKind: "fork" });

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
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  });

  // ── Autonomous mode: auto-decide via agent (named agent, or built-in flow-decision) ──
  if (options.isAutonomous?.()) {
    return spawnForkDecisionAgent(step, ctx, options);
  }

  // Signal that the fork step is active (waiting for user input)
  const forkAgentName = step.agent || "fork";
  options.onAgentStarted?.(forkAgentName, step.id, undefined, { nodeKind: "fork" });

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
    options.onAgentComplete?.(forkAgentName, step.id, makeForkResult("Auto-decide"), { nodeKind: "fork" });
    return spawnForkDecisionAgent(step, ctx, options);
  }

  // Handle custom-decide: user typed freetext via "Other (describe)"
  if (response.answer === "__custom_decide__" && step.agent) {
    options.onAgentComplete?.(forkAgentName, step.id, makeForkResult(response.notes || "Custom"), { nodeKind: "fork" });
    return spawnForkDecisionAgent(step, ctx, options, response.notes);
  }

  // User selected an option directly
  options.onAgentComplete?.(forkAgentName, step.id, makeForkResult(`Selected: ${response.answer}`), { nodeKind: "fork" });

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

/**
 * A `code-decision` runs its handler exactly like a `code` node (reusing
 * executeCodeStep) then routes on the reserved `branch` output resolved against
 * `branches:`. An execution failure (missing handler, throw, timeout, missing
 * declared/reserved output) has no `on_error` to fall back to, so it escalates
 * to a hard flow halt. An off-map `branch` is likewise a hard failure.
 */
async function executeCodeDecisionStep(step: CodeDecisionStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const result = await executeCodeStep(step, ctx, options, options.flow.name, options.flow.source);

  // Execution failure: code-decision has no on_error edge, so any soft/hard
  // failure halts the flow (mirrors a soft failure with no on_error).
  if (result.outcome !== "success") {
    result.outcome = "hard";
    result.failureInfo = {
      outcome: "hard",
      message: result.failureInfo?.message ?? result.output ?? "Hard failure",
      source: result.failureInfo?.source ?? "code_decision_hard_fail",
    };
    return { agentResult: result, nextStepId: undefined };
  }

  const branch = result.finishParams?.branch as string | undefined;

  // Off-map branch is a hard failure (consistent with agent-decision), halting
  // the flow independent of any routing.
  if (!branch || !(branch in step.branches)) {
    const valid = Object.keys(step.branches).join(", ");
    const message = `code-decision "${step.id}": branch "${branch ?? "(none)"}" is not in the branches map. Valid branches: ${valid}`;
    result.outcome = "hard";
    result.failureInfo = { outcome: "hard", message, source: "code_decision_off_map_branch" };
    result.result = { ...result.result, status: "error", summary: message };
    return { agentResult: result, nextStepId: undefined };
  }

  const { nextStepId } = routeDecisionBranch(step, ctx, options, branch);
  return { agentResult: result, nextStepId };
}

async function executeAgentDecisionStep(step: AgentDecisionStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const agentConfig = options.getAgent(step.agent);
  if (!agentConfig) return {};

  const decisionConfig = { ...agentConfig };
  const branchNames = Object.keys(step.branches);

  const decisionTask = expandTemplateVariables(step.task, {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  });

  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  };

  const skillContents = new Map<string, string>();
  if (decisionConfig.skills) {
    for (const skill of decisionConfig.skills) {
      const content = options.getSkillContent?.(skill);
      if (content) skillContents.set(skill, content);
    }
  }
  options.onAgentStarted?.(step.agent, step.id, undefined, { nodeKind: "agent-decision" });

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

  options.onAgentComplete?.(step.agent, step.id, result, { nodeKind: "agent-decision" });

  // Route via finish tool's branch parameter. A backward branch target loops
  // (bounded by max_iterations); a forward target exits.
  const branch = result.finishParams?.branch;
  if (branch && step.branches[branch]) {
    const { nextStepId } = routeDecisionBranch(step, ctx, options, branch);
    return { nextStepId, agentResult: result };
  }

  // Fallback: first branch when agent fails or branch missing
  const firstBranchLabel = Object.keys(step.branches)[0];
  const { nextStepId } = routeDecisionBranch(step, ctx, options, firstBranchLabel);
  return { nextStepId, agentResult: result };
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Validate a structured flow-input object against the flow's declared schema.
 * Returns an error message on the first violation, or null when valid.
 * (change: flow-typed-io-and-run-state)
 */
function validateFlowInput(flow: FlowConfig, input: Record<string, unknown> | undefined): string | null {
  if (!flow.inputs) return null;
  const provided = input ?? {};
  for (const [name, decl] of Object.entries(flow.inputs)) {
    if (!Object.prototype.hasOwnProperty.call(provided, name)) {
      if (decl.required) return `Flow "${flow.name}": missing required input "${name}"`;
      continue;
    }
    const v = provided[name];
    const t = decl.type;
    const ok =
      t === "string" ? typeof v === "string" :
      t === "number" ? typeof v === "number" :
      t === "boolean" ? typeof v === "boolean" :
      t === "array" ? Array.isArray(v) :
      t === "object" ? (typeof v === "object" && v !== null && !Array.isArray(v)) :
      true;
    if (!ok) return `Flow "${flow.name}": input "${name}" expected ${t}, got ${Array.isArray(v) ? "array" : typeof v}`;
  }
  return null;
}

function storeResult(ctx: FlowContext, stepId: string, result: AgentResult): void {
  ctx.results[stepId] = {
    fullOutput: result.output,
    status: result.result.status,
    summary: result.result.summary,
    // Typed declared outputs live in their own map, in real JSON types.
    outputs: result.typedOutputs ?? {},
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
