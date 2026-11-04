import type { DeciderSpec, DecisionEvent, AgentStartedExtra, FlowConfig, FlowStep, AgentStep, ForkStep, AgentDecisionStep, TemplateContext, AgentResult, FlowResult, CodeStep, CodeDecisionStep, NodeKind, StepResultValue, ItemRef } from "./types.js";
import { executeCodeStep } from "./execute-code-step.js";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { expandTemplateVariables, spawnAgent, loadContextFiles } from "./execution.js";
import { resolveRouteOutcome } from "./failure.js";
import type { FailureInfo, ModelFallbackInfo } from "./types.js";
import { resolveAgentModel, type ParentModelSnapshot } from "./model-roles.js";
import { parseResult, hasArtifactElement } from "./result-parser.js";

import { raceWithAbort } from "./abort-utils.js";
import { reservedOutputProblems } from "./reserved-outputs.js";
import { decide, describeAttempts, resolveDecider } from "./decider/chain.js";
import { buildQuestion, decisionAgentContext } from "./decider/question.js";
import { makeEntryRunner } from "./decider/runtime.js";
import { systemOneConsumerId } from "./decider/system-one.js";
import type { ClassifierEntry, DecisionOutcome, EntryResult } from "./decider/types.js";
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
  /** Internal: steps that are fan-out branch targets (their skipped result carries `items: []`). */
  fanoutTargets?: Set<string>;
}

export interface FlowRunOptions {
  flow: FlowConfig;
  task: string;
  /** Structured flow-level inputs, validated against `flow.inputs`. */
  flowInput?: Record<string, unknown>;
  cwd: string;
  /** Session model registry (`ctx.modelRegistry`) — backs model resolution. */
  modelRegistry?: any;
  /** Parent session's providers/keys runtime, shared with every agent session. */
  modelRuntime?: any;
  /** Session model (+ thinking) snapshot taken at flow start — the fallback target. */
  parentModel?: ParentModelSnapshot;
  /** `flows.modelFallback` (default "session"), frozen for the run. */
  modelFallback?: "session" | "error";
  /** `flows.decisionAgent`, frozen for the run. */
  decisionAgent?: string;
  /** `flows.decider`, frozen for the run. */
  decider?: DeciderSpec;
  /** pi's project-trust decision for `cwd` (gates project System One config). */
  projectTrusted?: boolean;
  /** Test seam: replace a decider entry (`system-one` or `provider/model`). */
  entryOverrides?: Record<string, ClassifierEntry>;
  /** One call per decision, with every attempt (change: classifier-decisions). */
  onDecision?: (event: DecisionEvent) => void;
  /** Operator's live SessionManager — forked into agents declaring `fork_session`. */
  mainSessionManager?: any;
  extraAgentExtensions?: any[];
  /** Extension-registered custom tool definitions passed to spawned agent sessions. */
  extraCustomTools?: any[];
  /** Extension API handle — threaded into `resolveModel` (event-bus) and
   *  forwarded into `spawnAgent` so subagents share the same handle. */
  pi: ExtensionAPI;
  getAgent: (name: string) => any;  // AgentConfig lookup
  getSkill?: (name: string) => Skill | undefined;
  askUser: (question: string, type: string, options?: string[], extra?: any) => Promise<{ answer: string; notes?: string }>;
  onAgentStarted?: (agentName: string, stepId: string, resolvedModel?: string, extra?: AgentStartedExtra) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult, extra?: { nodeKind?: NodeKind; target?: string; itemIndex?: number; itemCount?: number }) => void;
  // `item` is set for a fan-out instance (change: multi-route-decisions).
  onToolCall?: (agentName: string, stepId: string, toolName: string, input: any, item?: ItemRef) => void;
  onToolResult?: (agentName: string, stepId: string, toolName: string, output: any, isError: boolean, item?: ItemRef) => void;
  onAssistantText?: (agentName: string, stepId: string, text: string, item?: ItemRef) => void;
  onThinkingText?: (agentName: string, stepId: string, text: string, item?: ItemRef) => void;
  onExtensionUIRequest?: (agentName: string, request: any, respond: (response: any) => void, meta?: { stepId: string; item?: ItemRef }) => void;
  onLoopIteration?: (stepId: string, iteration: number, maxIterations: number, loopTarget?: string) => void;
  isAutonomous?: () => boolean;
  onAutoDecision?: (forkId: string, agentName: string, chosenBranch: string, targetStepId: string, detail?: { confidence?: number }) => void;
  onNotify?: (message: string) => void;
  signal?: AbortSignal;
}

// ---- Segment types ---------------------------------------------------------

type Segment =
  | {
      type: "dag";
      steps: AgentStep[];
      activeSteps?: Set<string>;
      /** Set by a multi decision for one run: inactive steps get `skipped`, replacing earlier results. */
      overwriteSkipped?: boolean;
      /** Set by a multi decision for one run: fan-out target → its items. */
      fanout?: Map<string, unknown[]>;
    }
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

  // Agents declaring a reserved output name (finish-tool fields, or `branch` on
  // a decision agent) would silently misroute; refuse the run before any step.
  const reserved = reservedOutputProblems(flow, options.getAgent);
  if (reserved.length) {
    const msg = `Flow "${flow.name}" not started: ${reserved.join("; ")}`;
    const errResult: AgentResult = {
      success: false, output: msg, stderr: "", exitCode: null,
      result: { status: "error" as const, summary: msg, files: [], artifacts: "" },
      toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
      outcome: "hard", failureInfo: { outcome: "hard", message: msg, source: "reserved_output" },
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
    fanoutTargets: fanoutTargetsOf(flow.steps),
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
      if (userSignal?.aborted) throw new FlowCancelledError();

      const segment = segments[segmentIndex];

      if (segment.type === "dag") {

        const multiRun = segment.overwriteSkipped ? { overwriteSkipped: true, fanout: segment.fanout } : undefined;
        if (multiRun) {
          // One-shot: a multi decision re-routes on every entry.
          segment.overwriteSkipped = undefined;
          segment.fanout = undefined;
        }
        const dagResult = await runDagSegment(segment.steps, maxConcurrent, ctx, effectiveOptions, segment.activeSteps, multiRun);
        if (multiRun) segment.activeSteps = undefined;
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

        // Multi decision: activate the union of the chosen targets in the next
        // segment (every other step there is skipped); fan-out targets run per item.
        if (stepResult.multi) {
          const nextIdx = segmentIndex + 1;
          const nextSeg = segments[nextIdx];
          if (nextSeg?.type === "dag") {
            const active = new Set<string>();
            for (const t of stepResult.multi.targets) for (const a of computeActiveSteps(nextSeg.steps, t)) active.add(a);
            nextSeg.activeSteps = active;
            nextSeg.overwriteSkipped = true;
            nextSeg.fanout = stepResult.multi.items;
          }
          segmentIndex = nextIdx;
          continue;
        }

        const st = segment.step.stepType;
        if (st === "fork" || st === "agent-decision" || st === "code-decision") markUntakenBranchesSkipped(ctx, segment.step, stepResult);

        // Multi-select fork: the selected branches already ran inside the fork.
        // Continue in the furthest branch segment with only the steps reachable
        // from them (the selected branches themselves keep their results).
        if (stepResult.ranBranches) {
          const ran = stepResult.ranBranches;
          const idxs = ran.map((id) => findSegmentIndex(segments, id)).filter((i) => i >= 0);
          if (idxs.length) {
            const targetIdx = Math.max(...idxs);
            const targetSeg = segments[targetIdx];
            if (targetSeg.type === "dag") {
              const active = new Set<string>();
              for (const id of ran) {
                if (targetSeg.steps.some((s) => s.id === id)) {
                  for (const a of computeActiveSteps(targetSeg.steps, id)) active.add(a);
                }
              }
              for (const id of ran) active.delete(id);
              targetSeg.activeSteps = active;
              segmentIndex = targetIdx;
            } else {
              segmentIndex = targetIdx + 1;
            }
            continue;
          }
        }

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

  // If aborted, mark any agent steps that didn't complete as aborted
  if (options.signal?.aborted) {
    for (const step of flow.steps) {
      if (step.stepType === "agent" && !ctx.results[step.id]) {
        ctx.results[step.id] = {
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
  multiRun?: { overwriteSkipped: boolean; fanout?: Map<string, unknown[]> },
): Promise<DagSegmentResult> {
  const completed = new Set<string>();
  let lastResult: AgentResult | null = null;
  let waveNumber = 0;
  let lastSnapshot = "";
  let deadlockCount = 0;

  // Cross-segment blockedBy: deps referencing steps outside this DAG segment
  // are already satisfied (the preceding separator/segment completed before us).
  const segmentStepIds = new Set(steps.map(s => s.id));

  // An on_error source is an implicit dependency of its target: the target
  // waits for the source to settle (so it sees the failed step's result).
  const depsOf = new Map<string, string[]>(steps.map(s => [s.id, [...(s.blockedBy ?? [])]]));
  for (const s of steps) {
    if (s.on_error && segmentStepIds.has(s.on_error)) depsOf.get(s.on_error)!.push(s.id);
  }

  // If activeSteps is set (branch exclusivity), skip inactive steps immediately
  if (activeSteps) {
    for (const step of steps) {
      if (!activeSteps.has(step.id)) {
        completed.add(step.id);
        // Store synthetic "skipped" result so blockedBy refs auto-satisfy. A
        // step that already has a result (e.g. completed before a loop
        // re-entered this segment) keeps it.
        // A multi decision's segment replaces stale results from an earlier pass.
        if (!ctx.results[step.id] || multiRun?.overwriteSkipped) {
          ctx.results[step.id] = skippedValue(ctx, step.id);
        }
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
      return depsOf.get(s.id)!.every(dep => completed.has(dep) || !segmentStepIds.has(dep));
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
          const items = multiRun?.fanout?.get(step.id);
          const r = items
            ? await runFanoutInstances(step, items, Math.max(1, maxConcurrent - (batch.length - 1)), ctx, options)
            : await executeAgentStep(step, ctx, options);
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
                ctx.results[s.id] = skippedValue(ctx, s.id);
              }
            }
          } else {
            // Route outside this DAG: skip all remaining steps, signal the main loop
            for (const s of steps) {
              if (!completed.has(s.id)) {
                completed.add(s.id);
                ctx.results[s.id] = skippedValue(ctx, s.id);
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
  /** Multi-select fork: branch step ids already run inside the fork. */
  ranBranches?: string[];
  /** Multi decision: chosen forward targets (possibly none) and fan-out items per target. */
  multi?: { targets: string[]; items: Map<string, unknown[]> };
}

/**
 * Store a synthetic "skipped" result for every forward branch target of a fork
 * that was not taken (and has no result yet), whatever the target's step type.
 */
function markUntakenBranchesSkipped(ctx: FlowContext, step: { id: string; branches?: Record<string, string> }, stepResult: StepResult): void {
  if (!stepResult.nextStepId && !stepResult.ranBranches) return;
  const taken = new Set([stepResult.nextStepId, ...(stepResult.ranBranches ?? [])]);
  for (const target of Object.values(step.branches ?? {})) {
    if (taken.has(target) || ctx.results[target] || isBackwardTarget(ctx.steps, step.id, target)) continue;
    ctx.results[target] = skippedValue(ctx, target);
  }
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
  // `loopCounters[id]` holds the 1-based number of the pass now running (what
  // `${{loop.<id>.iteration}}` expands to), so the pass count is already
  // visible to the loop body: pass N observes N. Loop-backs taken = pass - 1.
  const pass = ctx.loopCounters[step.id] ?? 1;
  const taken = pass - 1;
  if (max !== undefined && taken >= max) {
    // Cap reached: stop looping, force exit (fall through to the next segment).
    return { nextStepId: undefined };
  }
  const iteration = taken + 1; // loop-backs taken including this one (event payload)
  ctx.loopCounters[step.id] = pass + 1;

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

/**
 * Resolve an agent's model before spawning (so observers see it and spawn
 * receives the resolved Model object). Failure is deferred: spawnAgent
 * re-resolves and reports the error on the step.
 */
function preResolveModel(agentConfig: any, options: FlowRunOptions): {
  resolvedModelId?: string;
  fallback?: ModelFallbackInfo;
  spawn: Record<string, unknown>;
} {
  const spawn: Record<string, unknown> = { parentModel: options.parentModel, modelFallback: options.modelFallback };
  try {
    // Keep the thinking level too (frontmatter `thinking:` > ref level from
    // role/suffix) — dropping it lets pi's defaultThinkingLevel take over.
    const r = resolveAgentModel(options.pi, agentConfig, {
      registry: options.modelRegistry,
      parentModel: options.parentModel,
      modelFallback: options.modelFallback,
    });
    return {
      resolvedModelId: r.modelId,
      fallback: r.fallback,
      spawn: { ...spawn, resolvedModel: r.model, resolvedModelId: r.modelId, resolvedThinking: r.thinking },
    };
  } catch {
    return { spawn };
  }
}

type DecisionAgentPick =
  | { ok: true; agent: any; name: string }
  | { ok: false; name: string; source: string };

/** Decision agent: step agent → flow decision_agent → flows.decisionAgent → flow-decision. */
function pickDecisionAgent(step: { agent?: string }, ctx: FlowContext, options: FlowRunOptions): DecisionAgentPick {
  let name: string;
  let source: string;
  if (step.agent) { name = step.agent; source = "the step's agent:"; }
  else if (options.flow.decision_agent) { name = options.flow.decision_agent; source = "the flow's decision_agent:"; }
  else if (options.decisionAgent) { name = options.decisionAgent; source = "flows.decisionAgent"; }
  else { name = "flow-decision"; source = "the built-in default"; }
  const agent = options.getAgent(name);
  return agent ? { ok: true, agent, name } : { ok: false, name, source };
}

function decisionAgentMissing(pick: { name: string; source: string }): AgentResult {
  const msg = `Decision agent not found: "${pick.name}" (configured via ${pick.source}). Ensure the agent exists in the catalog.`;
  return {
    success: false, output: msg, stderr: msg, exitCode: 1,
    result: { status: "error" as const, files: [], artifacts: "", summary: msg },
    toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
    outcome: "soft",
    failureInfo: { outcome: "soft", message: msg, source: "decision_agent_missing" },
  };
}

async function executeAgentStep(
  step: AgentStep,
  ctx: FlowContext,
  options: FlowRunOptions,
  item?: { value: unknown; index: number; count: number },
): Promise<AgentResult | null> {
  const ref: ItemRef | undefined = item ? { index: item.index, count: item.count } : undefined;
  const itemExtra = item ? { itemIndex: item.index, itemCount: item.count } : {};
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
    options.onAgentStarted?.(step.agent, step.id, undefined, { nodeKind: "agent", ...itemExtra });
    options.onAgentComplete?.(step.agent, step.id, errorResult, { nodeKind: "agent", ...itemExtra });
    return errorResult;
  }

  // Resolve model early so it's available for onAgentStarted observers
  const pre = preResolveModel(agentConfig, options);
  options.onAgentStarted?.(step.agent, step.id, pre.resolvedModelId, { nodeKind: "agent", ...itemExtra, ...(pre.fallback ? { modelFallback: pre.fallback } : {}) });

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
      ...(item ? { item: { value: item.value, index: item.index } } : {}),
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
    ...(item ? { item: { value: item.value, index: item.index } } : {}),
  };

  // Determine user message: step task override or fallback to flow task
  const userTask = step.task ? expandTemplateVariables(step.task, templateCtx) : ctx.task;

  // Resolve declared skills to pi `Skill` objects (name + description +
  // location); they are advertised in the prompt so the agent reads them on
  // demand. Unresolvable names are skipped.
  const skills: Skill[] = [];
  if (agentConfig.skills) {
    for (const name of agentConfig.skills) {
      const s = options.getSkill?.(name);
      if (s) skills.push(s);
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
    skills,
    preambleSections,
    pi: options.pi,
    cwd: options.cwd,
    modelRegistry: options.modelRegistry,
      modelRuntime: options.modelRuntime,
    mainSessionManager: options.mainSessionManager,
    extraAgentExtensions: options.extraAgentExtensions,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, agentConfig.tools),
    onToolCall: (name, input) => options.onToolCall?.(step.agent, step.id, name, input, ref),
    onToolResult: (name, output, err) => options.onToolResult?.(step.agent, step.id, name, output, err, ref),
    onAssistantText: (text) => options.onAssistantText?.(step.agent, step.id, text, ref),
    onThinkingText: (text) => options.onThinkingText?.(step.agent, step.id, text, ref),
    onExtensionUIRequest: options.onExtensionUIRequest
      ? (request, respond) => options.onExtensionUIRequest!(step.agent, request, respond, { stepId: step.id, ...(ref ? { item: ref } : {}) })
      : undefined,
    signal: options.signal,
    ...pre.spawn,
  });

  options.onAgentComplete?.(step.agent, step.id, result, { nodeKind: "agent", ...itemExtra });
  return result;
}

// ---- Fan-out (change: multi-route-decisions) --------------------------------

/** Every step that is the target of a fan-out branch. */
function fanoutTargetsOf(steps: FlowStep[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps) {
    const fan = (s as { branchFanout?: Record<string, unknown> }).branchFanout;
    const br = (s as { branches?: Record<string, string> }).branches;
    if (fan && br) for (const label of Object.keys(fan)) if (br[label]) out.add(br[label]);
  }
  return out;
}

/** A synthetic `skipped` result; a fan-out target's carries `items: []`. */
function skippedValue(ctx: FlowContext, stepId: string): StepResultValue {
  return {
    fullOutput: "", status: "skipped", summary: "", outputs: {},
    ...(ctx.fanoutTargets?.has(stepId) ? { items: [] } : {}),
  };
}

const toValue = (r: AgentResult): StepResultValue => ({
  status: r.result.status,
  summary: r.result.summary,
  fullOutput: r.output,
  outputs: r.typedOutputs ?? {},
});

/**
 * Run the target step once per item (at most `poolSize` at a time) and fold the
 * instances into one aggregate result. A soft instance failure lets siblings
 * finish; a hard one halts the run and stops launching instances.
 */
async function runFanoutInstances(
  step: AgentStep,
  items: unknown[],
  poolSize: number,
  ctx: FlowContext,
  options: FlowRunOptions,
): Promise<AgentResult> {
  const count = items.length;
  const results: Array<AgentResult | null> = new Array(count).fill(null);
  let next = 0;
  let hard: AgentResult | undefined;
  const worker = async () => {
    while (next < count && !hard && !options.signal?.aborted) {
      const index = next++;
      const r = await executeAgentStep(step, ctx, options, { value: items[index], index, count });
      results[index] = r;
      if (r && r.outcome === "hard" && !hard) {
        hard = r;
        if (!ctx.hardFail) {
          ctx.hardFail = r.failureInfo ?? { outcome: "hard", message: r.output || "Hard failure", source: "node_hard_fail" };
          ctx.requestHalt?.();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(poolSize, Math.max(count, 1)) }, worker));

  const values: StepResultValue[] = results.map((r) =>
    r ? toValue(r) : { status: options.signal?.aborted ? "aborted" : "skipped", summary: "", fullOutput: "", outputs: {} });
  const complete = values.filter((v) => v.status === "complete").length;
  const failed = count - complete;
  const allOk = failed === 0;
  const summary = count === 0 ? "0 items" : `${count} items: ${complete} complete, ${failed} failed`;
  const outcome = hard ? "hard" : allOk ? "success" : "soft";
  const aggregate: AgentResult = {
    success: allOk,
    output: "",
    stderr: "",
    exitCode: allOk ? 0 : 1,
    result: { status: allOk ? "complete" : "error", summary, files: [], artifacts: "" },
    toolCalls: [],
    duration: results.reduce((d, r) => d + (r?.duration ?? 0), 0),
    tokens: results.reduce((t, r) => ({ input: t.input + (r?.tokens.input ?? 0), output: t.output + (r?.tokens.output ?? 0) }), { input: 0, output: 0 }),
    outcome,
    ...(outcome !== "success" ? { failureInfo: hard?.failureInfo ?? { outcome, message: `"${step.id}": ${summary}`, source: "fanout_item_failed" } } : {}),
    items: values,
  };
  if (hard) storeResult(ctx, step.id, aggregate);
  return aggregate;
}

/**
 * Resolve the routes of a `multi: true` decision (change: multi-route-decisions):
 * a backward branch alone loops (or, at the cap, chooses nothing); a backward
 * branch with other routes, a non-array `for_each`, or more items than
 * `max_items` soft-fails the decision; otherwise the chosen forward targets
 * activate the next segment. `decision` is the decision's own result; it is
 * stored first so `for_each` may reference the decision's outputs.
 */
function resolveMultiRoutes(
  step: (AgentDecisionStep | CodeDecisionStep),
  routes: Array<{ branch: string; items?: unknown[] }>,
  decision: AgentResult,
  ctx: FlowContext,
  options: FlowRunOptions,
): { stepResult: StepResult; routes: Array<{ branch: string; itemCount?: number }>; routeError?: string } {
  const fail = (message: string) => {
    const failed: AgentResult = {
      ...decision,
      success: false,
      output: message,
      result: { ...decision.result, status: "error", summary: message },
      outcome: "soft",
      failureInfo: { outcome: "soft", message, source: "multi_route_failed" },
    };
    return { stepResult: routeExhaustedDecision(failed, step.on_error), routes: [], routeError: message };
  };

  const labels = routes.map((r) => r.branch);
  const backward = labels.filter((l) => isBackwardTarget(ctx.steps, step.id, step.branches[l]));
  if (backward.length && labels.length > 1) {
    return fail(`${step.stepType} "${step.id}": a loop branch must be chosen alone (got ${labels.map((l) => `"${l}"`).join(", ")})`);
  }
  if (backward.length === 1) {
    const { nextStepId } = routeDecisionBranch(step, ctx, options, backward[0]);
    if (nextStepId) return { stepResult: { agentResult: decision, nextStepId }, routes: [{ branch: backward[0] }] };
    // Cap reached: the multi decision acts as if it chose nothing.
    return { stepResult: { agentResult: decision, multi: { targets: [], items: new Map() } }, routes: [] };
  }

  storeResult(ctx, step.id, decision);
  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {}, results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  };
  const targets: string[] = [];
  const items = new Map<string, unknown[]>();
  const out: Array<{ branch: string; itemCount?: number }> = [];
  for (const r of routes) {
    const target = step.branches[r.branch];
    targets.push(target);
    const fan = step.branchFanout?.[r.branch];
    if (!fan) { out.push({ branch: r.branch }); continue; }
    let list: unknown[];
    if (r.items) list = r.items;
    else if (fan.for_each === "dynamic") list = [];
    else {
      const raw = expandTemplateVariables(fan.for_each, templateCtx).trim();
      let parsed: unknown = raw;
      if (raw === "") parsed = [];
      else { try { parsed = JSON.parse(raw); } catch { /* not JSON */ } }
      if (!Array.isArray(parsed)) {
        return fail(`${step.stepType} "${step.id}": branch "${r.branch}" for_each must resolve to an array (got ${JSON.stringify(raw.slice(0, 80))})`);
      }
      list = parsed;
    }
    const max = fan.max_items ?? 50;
    if (list.length > max) {
      return fail(`${step.stepType} "${step.id}": branch "${r.branch}" has ${list.length} items, more than max_items ${max}`);
    }
    items.set(target, list);
    out.push({ branch: r.branch, itemCount: list.length });
  }
  return { stepResult: { agentResult: decision, multi: { targets, items } }, routes: out };
}

/**
 * Decide a fork branch through the decider chain (autonomous mode,
 * `__auto_decide__`, and `__custom_decide__` paths). The `agent` entry spawns
 * the fork's decision agent (the built-in `flow-decision` when the fork has no
 * `agent:`). When every entry fails, `exhausted` is set and the step result is
 * a failed AgentResult — never a default branch.
 */
async function decideForkBranch(
  step: ForkStep,
  ctx: FlowContext,
  options: FlowRunOptions,
  customText?: string,
): Promise<{ stepResult: StepResult; exhausted: boolean }> {
  const branchNames = Object.keys(step.branches);
  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  };

  const baseTask = step.task
    ? expandTemplateVariables(step.task, templateCtx)
    : `The user was asked: "${step.question}"\nOptions: ${step.options.join(", ")}\nChoose the best option.`;
  let decisionTask = baseTask;
  // Enhance task with custom freetext context when provided
  if (customText) {
    decisionTask += `\n\nThe user typed a custom answer instead of picking an option: "${customText}"\nBased on their intent, choose the closest matching branch.`;
  }

  const run = await runDecision({
    step, ctx, options, nodeKind: "fork", templateCtx,
    task: step.task ? baseTask : step.question,
    fork: { question: step.question, options: step.options, userText: customText },
    runAgent: async (context) => {
      const pick = pickDecisionAgent(step, ctx, options);
      if (!pick.ok) return { result: decisionAgentMissing(pick), agentName: pick.name };
      const agentConfig = pick.agent;
      const agentName = pick.name;
      const pre = preResolveModel(agentConfig, options);
      options.onAgentStarted?.(agentName, step.id, pre.resolvedModelId, { nodeKind: "fork", ...(pre.fallback ? { modelFallback: pre.fallback } : {}) });
      const result = await spawnAgent({
        agent: agentConfig,
        task: `${decisionTask}\n\n${context}`,
        templateContext: templateCtx,
        pi: options.pi,
        cwd: options.cwd,
        modelRegistry: options.modelRegistry,
        modelRuntime: options.modelRuntime,
        extraAgentExtensions: options.extraAgentExtensions,
        extraCustomTools: filterExtensionTools(options.extraCustomTools, agentConfig.tools),
        decisionBranches: branchNames,
        onToolCall: (name, input) => options.onToolCall?.(agentName, step.id, name, input),
        onToolResult: (name, output, err) => options.onToolResult?.(agentName, step.id, name, output, err),
        onAssistantText: (text) => options.onAssistantText?.(agentName, step.id, text),
        onThinkingText: (text) => options.onThinkingText?.(agentName, step.id, text),
        signal: options.signal,
        ...pre.spawn,
      });
      options.onAgentComplete?.(agentName, step.id, result, { nodeKind: "fork" });
      return { result, agentName };
    },
  });

  if (run.label === undefined) {
    return { stepResult: routeExhaustedDecision(run.result, step.on_error), exhausted: true };
  }
  const branch = run.label;
  ctx.forks[step.id] = { answer: branch, notes: customText };
  storeForkContext(ctx, step, step.branches[branch], branch, customText, run.decidedBy);
  options.onAutoDecision?.(step.id, run.decidedBy, branch, step.branches[branch], run.confidence !== undefined ? { confidence: run.confidence } : undefined);
  return { stepResult: { nextStepId: step.branches[branch], agentResult: run.result }, exhausted: false };
}

async function executeForkStep(step: ForkStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const expandedQuestion = expandTemplateVariables(step.question, {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  });

  // ── Autonomous mode: auto-decide via agent (named agent, or built-in flow-decision) ──
  if (options.isAutonomous?.()) {
    return (await decideForkBranch(step, ctx, options)).stepResult;
  }

  // Signal that the fork step is active (waiting for user input)
  const forkAgentName = step.agent || "fork";
  options.onAgentStarted?.(forkAgentName, step.id, undefined, { nodeKind: "fork" });

  const extra: Record<string, boolean | Record<string, string>> = {};
  if (step.multiSelect) extra.multiSelect = true;
  if (step.allowCustom) extra.allowCustom = true;
  // Pass branch mapping and agent info for UI enhancement
  if (step.branches) extra.branches = step.branches;
  const canAutoDecide = hasAutoDecider(step, options);
  if (canAutoDecide) extra.hasAutoAgent = true;

  const response = await options.askUser(expandedQuestion, "select", step.options, extra);

  const makeForkResult = (summary: string): AgentResult => ({
    success: true, output: summary, stderr: "", exitCode: 0,
    result: { status: "complete" as const, files: [], artifacts: "", summary },
    toolCalls: [], duration: 0, tokens: { input: 0, output: 0 },
  });

  // Handle auto-decide: user chose to let the agent decide this fork
  if (response.answer === "__auto_decide__" && canAutoDecide) {
    options.onAgentComplete?.(forkAgentName, step.id, makeForkResult("Auto-decide"), { nodeKind: "fork" });
    return askAgainIfExhausted(step, ctx, options, await decideForkBranch(step, ctx, options));
  }

  // Handle custom-decide: user typed freetext via "Other (describe)"
  if (response.answer === "__custom_decide__" && canAutoDecide) {
    options.onAgentComplete?.(forkAgentName, step.id, makeForkResult(response.notes || "Custom"), { nodeKind: "fork" });
    return askAgainIfExhausted(step, ctx, options, await decideForkBranch(step, ctx, options, response.notes));
  }

  // User selected an option directly
  options.onAgentComplete?.(forkAgentName, step.id, makeForkResult(`Selected: ${response.answer}`), { nodeKind: "fork" });

  ctx.forks[step.id] = response;

  // Multi-select: execute all selected branches sequentially
  if (step.multiSelect && Array.isArray(response.answer)) {
    let lastResult: StepResult = {};
    const ranBranches: string[] = [];
    const selectedOptions = response.answer as unknown as string[];
    for (const ans of selectedOptions) {
      const branchStepId = step.branches[ans];
      if (!branchStepId) continue;
      ranBranches.push(branchStepId);
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
    return { ranBranches };
  }

  const nextStepId = step.branches[response.answer];

  // Store fork context for autowiring into the branch step
  if (nextStepId) {
    storeForkContext(ctx, step, nextStepId, response.answer, response.notes);
  }

  return { nextStepId };
}

/** A fork can be decided without the user when it has an agent, a decider chain or a flow decision_agent. */
function hasAutoDecider(step: ForkStep, options: FlowRunOptions): boolean {
  return !!(step.agent || step.decider?.entries || options.flow.decider?.entries || options.flow.decision_agent || options.decider?.entries);
}

/**
 * Interactive fork whose decider chain was exhausted: tell the user and ask
 * again with the same options (never a silent default branch).
 */
async function askAgainIfExhausted(
  step: ForkStep,
  ctx: FlowContext,
  options: FlowRunOptions,
  decided: { stepResult: StepResult; exhausted: boolean },
): Promise<StepResult> {
  if (!decided.exhausted) return decided.stepResult;
  if (options.signal?.aborted) throw new FlowCancelledError();
  options.onNotify?.(`Fork "${step.id}": no decider produced a valid answer — please choose an option.`);
  return executeForkStep(step, ctx, options);
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
 * `branches:`. An execution failure (throw, timeout, missing/non-string
 * `branch`, return-contract violation) is a soft failure: it routes to
 * `on_error` when set and halts the flow otherwise, exactly like a `code` node.
 * An off-map `branch` label is a hard failure that halts even with `on_error`.
 */
async function executeCodeDecisionStep(step: CodeDecisionStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const result = await executeCodeStep(step, ctx, options, options.flow.name, options.flow.source);

  // Execution failure: soft -> on_error; hard (or soft without on_error) halts.
  if (result.outcome !== "success") {
    if (resolveRouteOutcome(result, step.on_error) === "soft") return { agentResult: result, nextStepId: step.on_error };
    result.outcome = "hard";
    result.failureInfo = {
      outcome: "hard",
      message: result.failureInfo?.message ?? result.output ?? "Hard failure",
      source: result.failureInfo?.source ?? "code_decision_hard_fail",
    };
    return { agentResult: result, nextStepId: undefined };
  }

  if (step.multi) {
    const routes = (result.finishParams?.routes ?? []) as Array<{ branch: string; items?: unknown[] }>;
    return resolveMultiRoutes(step, routes, result, ctx, options).stepResult;
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
  const branchNames = Object.keys(step.branches);
  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations, flowInput: ctx.flowInput,
  };
  const decisionTask = expandTemplateVariables(step.task, templateCtx);

  const run = await runDecision({
    step, ctx, options, nodeKind: "agent-decision", templateCtx, task: decisionTask,
    runAgent: async (context) => {
      const pick = pickDecisionAgent(step, ctx, options);
      if (!pick.ok) {
        const failed = decisionAgentMissing(pick);
        options.onAgentStarted?.(pick.name, step.id, undefined, { nodeKind: "agent-decision" });
        options.onAgentComplete?.(pick.name, step.id, failed, { nodeKind: "agent-decision" });
        return { result: failed, agentName: pick.name };
      }
      const decisionConfig = { ...pick.agent };
      const agentName = pick.name;
      const skills: Skill[] = [];
      if (decisionConfig.skills) {
        for (const name of decisionConfig.skills) {
          const s = options.getSkill?.(name);
          if (s) skills.push(s);
        }
      }
      const pre = preResolveModel(decisionConfig, options);
      options.onAgentStarted?.(agentName, step.id, pre.resolvedModelId, { nodeKind: "agent-decision", ...(pre.fallback ? { modelFallback: pre.fallback } : {}) });

      const result = await spawnAgent({
        agent: decisionConfig,
        task: `${decisionTask}\n\n${context}`,
        templateContext: templateCtx,
        skills,
        pi: options.pi,
        cwd: options.cwd,
        modelRegistry: options.modelRegistry,
        modelRuntime: options.modelRuntime,
        extraAgentExtensions: options.extraAgentExtensions,
        extraCustomTools: filterExtensionTools(options.extraCustomTools, decisionConfig.tools),
        decisionBranches: branchNames,
        decisionMulti: step.multi === true,
        onToolCall: (name, input) => options.onToolCall?.(agentName, step.id, name, input),
        onToolResult: (name, output, err) => options.onToolResult?.(agentName, step.id, name, output, err),
        onAssistantText: (text) => options.onAssistantText?.(agentName, step.id, text),
        onThinkingText: (text) => options.onThinkingText?.(agentName, step.id, text),
        signal: options.signal,
        ...pre.spawn,
      });
      options.onAgentComplete?.(agentName, step.id, result, { nodeKind: "agent-decision" });
      return { result, agentName };
    },
  });

  if (run.label === undefined) {
    run.emit?.({});
    return routeExhaustedDecision(run.result, step.on_error);
  }

  if (step.multi) {
    const labels = run.labels ?? [];
    const m = resolveMultiRoutes(step, labels.map((branch) => ({ branch })), run.result, ctx, options);
    run.emit?.({ labels, routes: m.routes, ...(m.routeError ? { routeError: m.routeError } : {}) });
    return m.stepResult;
  }

  // A backward branch target loops (bounded by max_iterations); a forward target exits.
  const { nextStepId } = routeDecisionBranch(step, ctx, options, run.label);
  return { nextStepId, agentResult: run.result };
}

// ---- Decider chain (change: classifier-decisions) ---------------------------

const MAX_REASON_CHARS = 200;
const capReason = (s: string): string => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s);

/**
 * Route an exhausted decision. Soft + `on_error` → jump there; anything else
 * (hard, or soft without `on_error`) escalates to a flow halt, like code steps.
 */
function routeExhaustedDecision(result: AgentResult, onError: string | undefined): StepResult {
  if (resolveRouteOutcome(result, onError) === "soft") return { agentResult: result, nextStepId: onError };
  result.outcome = "hard";
  result.failureInfo = {
    outcome: "hard",
    message: result.failureInfo?.message ?? result.output ?? "Hard failure",
    source: result.failureInfo?.source ?? "decision_exhausted",
  };
  return { agentResult: result, nextStepId: undefined };
}

interface RunDecisionArgs {
  step: ForkStep | AgentDecisionStep;
  ctx: FlowContext;
  options: FlowRunOptions;
  nodeKind: NodeKind;
  templateCtx: TemplateContext;
  /** Expanded task (a fork without `task:` passes its question). */
  task: string;
  fork?: { question: string; options: string[]; userText?: string };
  /** Spawns the decision agent — the `agent` chain entry. */
  /** Spawn the decision agent; `context` lists the branches (with `means`) and the declared state. */
  runAgent: (context: string) => Promise<{ result: AgentResult; agentName: string }>;
}

interface DecisionRun {
  /** Routed label; undefined when the chain was exhausted. */
  label?: string;
  /** Multi decision: every chosen label (possibly empty). */
  labels?: string[];
  /** Multi decision: emit `flow:decision` after routes are resolved. */
  emit?: (extra: Partial<DecisionEvent>) => void;
  /** Result to report for the step (agent result, synthetic classifier result, or failure). */
  result: AgentResult;
  /** Agent name or classifier entry that decided (for fork context / auto-decision). */
  decidedBy: string;
  /** Confidence of a classifier answer that routed (absent for the agent). */
  confidence?: number;
}

/**
 * One decision point through `resolveDecider` → `decide()`. Emits
 * `onDecision`, and a lifecycle pair when a classifier (not the agent) routed.
 */
async function runDecision(a: RunDecisionArgs): Promise<DecisionRun> {
  const { step, options } = a;
  const labels = Object.keys(step.branches);
  const multi = (step as { multi?: boolean }).multi === true;
  const resolved = resolveDecider(step.decider, options.flow.decider, options.decider);
  // Classifiers answer one label; they never decide a multi decision.
  if (multi) resolved.entries = ["agent"];

  let declaredState: Record<string, string> | undefined;
  if (step.state) {
    declaredState = {};
    for (const [k, v] of Object.entries(step.state)) declaredState[k] = expandTemplateVariables(v, a.templateCtx);
  }
  const question = buildQuestion({
    branches: step.branches,
    branchMeans: step.branchMeans,
    options: a.fork?.options,
    question: a.fork?.question,
    task: a.task,
    declaredState,
    userText: a.fork?.userText,
  });

  let agentName = "";
  const run = makeEntryRunner({
    env: options,
    flowName: options.flow.name,
    stepId: step.id,
    branchCount: labels.length,
    question,
    agentEntry: async (): Promise<EntryResult> => {
      const { result, agentName: name } = await a.runAgent(
        decisionAgentContext(labels, step.branchMeans, declaredState, multi),
      );
      agentName = name;
      const branch = result.finishParams?.branch;
      const chosen = result.finishParams?.branches;
      // A decision agent that reports it could not finish has not decided,
      // even if it also named a branch.
      const status = result.result?.status;
      if (result.finishParams && (status === "blocked" || status === "error")) {
        return { ok: false, outcome: "invalid-label", reason: capReason(`the decision agent finished with status ${status}`), payload: result };
      }
      if (multi) {
        if (Array.isArray(chosen) && chosen.every((b) => typeof b === "string")) {
          return { ok: true, authoritative: true, answer: { label: chosen[0] ?? "", labels: chosen, confidence: 1 }, payload: result };
        }
      } else if (typeof branch === "string" && branch) {
        return { ok: true, authoritative: true, answer: { label: branch, confidence: 1 }, payload: result };
      }
      // Never echo the agent's output/summary: the reason lands in `flow:decision`.
      const why = result.success === false
        ? capReason(`the decision agent failed: ${result.failureInfo?.message ?? "no usable result"}`)
        : "the decision agent finished without a branch";
      return { ok: false, outcome: "invalid-label", reason: why, payload: result };
    },
  });

  const outcome: DecisionOutcome = await decide({
    ...resolved,
    labels,
    run: (entry, signal) => run(entry, signal),
    signal: options.signal,
  });

  const event: DecisionEvent = {
    flowName: options.flow.name,
    stepId: step.id,
    nodeKind: a.nodeKind,
    consumerId: systemOneConsumerId(options.flow.name, step.id),
    chain: resolved.entries,
    attempts: outcome.attempts,
    ...(outcome.ok ? { routedBy: outcome.routedBy, ...(outcome.label ? { label: outcome.label } : {}) } : {}),
  };
  // A multi decision reports its routes after item expansion (the caller emits).
  const emit = (extra: Partial<DecisionEvent>) => options.onDecision?.({ ...event, ...extra });
  if (!multi) options.onDecision?.(event);

  if (!outcome.ok && outcome.aborted) throw new FlowCancelledError();

  const payload = outcome.payload as AgentResult | undefined;
  if (!outcome.ok) {
    const msg = `${step.stepType} "${step.id}": no decider produced a trusted, valid label.\n${describeAttempts(outcome.attempts, labels)}`;
    const failedOutcome = payload?.outcome === "hard" ? "hard" : "soft";
    const failed: AgentResult = {
      success: false, output: msg, stderr: msg, exitCode: 1,
      result: { status: "error" as const, files: [], artifacts: "", summary: msg },
      toolCalls: payload?.toolCalls ?? [], duration: payload?.duration ?? 0, tokens: payload?.tokens ?? { input: 0, output: 0 },
      // Soft, unless the decision agent itself hard-failed (e.g. terminal API
      // error): soft lets `on_error` route; the caller escalates when unset.
      outcome: failedOutcome,
      failureInfo: { outcome: failedOutcome, message: msg, source: "decision_exhausted" },
    };
    if (!payload) {
      // No agent ran, so observers never saw the step: show the failure on it.
      options.onAgentStarted?.("decider", step.id, undefined, { nodeKind: a.nodeKind });
      options.onAgentComplete?.("decider", step.id, failed, { nodeKind: a.nodeKind });
    }
    return { result: failed, decidedBy: agentName, ...(multi ? { emit } : {}) };
  }

  if (outcome.routedBy === "agent" && payload) {
    return { label: outcome.label, ...(outcome.labels ? { labels: outcome.labels } : {}), result: payload, decidedBy: agentName, ...(multi ? { emit } : {}) };
  }

  // A classifier routed: no agent session ran. Report a synthetic result.
  const routed = outcome.attempts.find((x) => x.entry === outcome.routedBy && x.outcome === "ok");
  const conf = routed?.confidence !== undefined ? ` (confidence ${routed.confidence.toFixed(2)})` : "";
  const summary = `Decided "${outcome.label}" via ${outcome.routedBy}${conf}`;
  const result: AgentResult = {
    success: true, output: summary, stderr: "", exitCode: 0,
    result: { status: "complete" as const, files: [], artifacts: "", summary },
    toolCalls: [], duration: routed?.latencyMs ?? 0, tokens: { input: 0, output: 0 },
    outcome: "success",
  };
  options.onAgentStarted?.(outcome.routedBy, step.id, undefined, { nodeKind: a.nodeKind });
  options.onAgentComplete?.(outcome.routedBy, step.id, result, { nodeKind: a.nodeKind });
  return { label: outcome.label, result, decidedBy: outcome.routedBy, confidence: routed?.confidence };
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
    ...(result.items ? { items: result.items } : {}),
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
