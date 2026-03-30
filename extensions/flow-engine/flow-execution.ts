import type { FlowConfig, FlowStep, AgentStep, ForkStep, ConditionalStep, AgentDecisionStep, AgentLoopDecisionStep, FlowRefStep, TemplateContext, AgentResult, FlowResult } from "./types.js";
import { expandTemplateVariables, spawnAgent } from "./execution.js";
import { parseResult, hasArtifactElement } from "./result-parser.js";
import { parseFlowYamlFile } from "./flow-parser-yaml.js";
import { globSync } from "node:fs";
import { join } from "node:path";

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
}

export interface FlowRunOptions {
  flow: FlowConfig;
  task: string;
  cwd: string;
  authStorage?: any;
  modelRegistry?: any;
  extraGuardFactories?: any[];
  /** Extension-registered custom tool definitions passed to spawned agent sessions. */
  extraCustomTools?: any[];
  getModelRole?: (role: string) => string | undefined;
  getAgent: (name: string) => any;  // AgentConfig lookup
  getSkillContent?: (name: string) => string | undefined;
  getContextFiles?: (agent: any) => string[];
  askUser: (question: string, type: string, options?: string[], extra?: any) => Promise<{ answer: string; notes?: string }>;
  onAgentStarted?: (agentName: string, stepId: string) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult) => void;
  onToolCall?: (agentName: string, toolName: string, input: any) => void;
  onToolResult?: (agentName: string, toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (agentName: string, text: string) => void;
  onThinkingText?: (agentName: string, text: string) => void;
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
  };

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

        const result = await runDagSegment(segment.steps, maxConcurrent, ctx, options, segment.activeSteps);
        if (result) lastResult = result;
        segmentIndex++;
      } else {
        // Separator step (fork, conditional, agent-decision, flow-ref)

        const stepResult = await executeStep(segment.step, ctx, options);

        if (stepResult.agentResult) {
          lastResult = stepResult.agentResult;
          storeResult(ctx, segment.step.id, stepResult.agentResult);
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

async function runDagSegment(
  steps: AgentStep[],
  maxConcurrent: number,
  ctx: FlowContext,
  options: FlowRunOptions,
  activeSteps?: Set<string>,
): Promise<AgentResult | null> {
  const completed = new Set<string>();
  let lastResult: AgentResult | null = null;
  let waveNumber = 0;
  let lastSnapshot = "";
  let deadlockCount = 0;

  // If activeSteps is set (branch exclusivity), skip inactive steps immediately
  if (activeSteps) {
    for (const step of steps) {
      if (!activeSteps.has(step.id)) {
        completed.add(step.id);
        // Store synthetic "skipped" result so blockedBy refs auto-satisfy
        ctx.results[step.id] = {
          fullOutput: "",
          status: "skipped",
          summary: "",
          artifacts: "",
          files: "",
        };
      }
    }
  }

  while (completed.size < steps.length) {
    // Check abort before dispatching each wave
    if (options.signal?.aborted) break;

    waveNumber++;

    // Find unblocked steps within this segment
    const unblocked = steps.filter(s => {
      if (completed.has(s.id)) return false;
      if (!s.blockedBy) return true;
      return s.blockedBy.every(dep => completed.has(dep));
    });

    // Deadlock detection
    const snapshot = unblocked.map(s => s.id).sort().join(",");
    if (snapshot === lastSnapshot) {
      deadlockCount++;
      if (deadlockCount >= 3) {
        return { success: false, output: "Deadlock detected in DAG segment", stderr: "", exitCode: null, result: parseResult(""), toolCalls: [], duration: 0, tokens: { input: 0, output: 0 } };
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

    // Execute batch in parallel
    const results = await Promise.all(batch.map(step => executeAgentStep(step, ctx, options)));

    // Store results
    for (let i = 0; i < batch.length; i++) {
      const step = batch[i];
      const result = results[i];
      completed.add(step.id);
      if (result) {
        lastResult = result;
        storeResult(ctx, step.id, result);
      }
    }
  }

  return lastResult;
}

// ---- Step execution --------------------------------------------------------

interface StepResult {
  agentResult?: AgentResult;
  nextStepId?: string;
}

async function executeStep(step: FlowStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  switch (step.stepType) {
    case "agent": return executeAgentStepWithRouting(step, ctx, options);
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

  const nextStepId = result.success ? step.on_complete : step.on_error;
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

  options.onAgentStarted?.(step.agent, step.id);

  // Resolve step inputs at dispatch time
  const resolvedInputs: Record<string, string> = {};
  if (step.inputs) {
    const resolveCtx: TemplateContext = {
      task: ctx.task,
      inputs: {},
      results: ctx.results,
      forks: ctx.forks,
      loopCounters: ctx.loopCounters,
      loopMaxIterations: ctx.loopMaxIterations,
    };
    for (const [name, expr] of Object.entries(step.inputs)) {
      resolvedInputs[name] = expandTemplateVariables(expr, resolveCtx);
    }
  }

  const templateCtx: TemplateContext = {
    task: ctx.task,
    inputs: resolvedInputs,
    results: ctx.results,
    forks: ctx.forks,
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

  // Get context file contents
  const contextFiles = options.getContextFiles?.(agentConfig) ?? [];

  // Autowire fork context if this step was branched-to from a fork
  const forkCtx = ctx.pendingForkContext?.get(step.id);
  if (forkCtx) {
    const header = forkCtx.decidedBy ? "Auto Decision" : "User Decision";
    let section = `## ${header}: ${forkCtx.forkId}\nQuestion: ${forkCtx.question}\nSelected: ${forkCtx.answer}`;
    if (forkCtx.notes) section += `\nNotes: ${forkCtx.notes}`;
    if (forkCtx.decidedBy) section += `\nDecided by: ${forkCtx.decidedBy}`;
    contextFiles.push(section);
    // Remove so it's only injected into the immediate branch step
    ctx.pendingForkContext!.delete(step.id);
  }

  const result = await spawnAgent({
    agent: agentConfig,
    task: userTask,
    templateContext: templateCtx,
    skillContents,
    contextFileContents: contextFiles,
    getModelRole: options.getModelRole,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraGuardFactories: options.extraGuardFactories,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, agentConfig.tools),
    onToolCall: (name, input) => options.onToolCall?.(step.agent, name, input),
    onToolResult: (name, output, err) => options.onToolResult?.(step.agent, name, output, err),
    onAssistantText: (text) => options.onAssistantText?.(step.agent, text),
    onThinkingText: (text) => options.onThinkingText?.(step.agent, text),
    onExtensionUIRequest: options.onExtensionUIRequest
      ? (request, respond) => options.onExtensionUIRequest!(step.agent, request, respond)
      : undefined,
    signal: options.signal,
  });

  options.onAgentComplete?.(step.agent, step.id, result);
  return result;
}

/** Fallback agent config when flow-decision is not in the agent catalog. */
const FALLBACK_DECISION_AGENT: AgentConfig = {
  name: "flow-decision",
  description: "Makes autonomous decisions at fork and loop-decision points",
  model: "@fast",
  tools: [],
  systemPrompt: "You are a flow decision agent. Analyze the question and options, then choose the best option. Call finish with your chosen branch and a brief summary.",
  source: "<fallback>",
};

/**
 * Spawn the fork's decision agent to choose a branch.
 * Used by autonomous mode, __auto_decide__, and __custom_decide__ paths.
 * When the fork has no agent: field, uses the built-in `flow-decision` agent
 * (or a minimal fallback if not found in the catalog).
 */
async function spawnForkDecisionAgent(
  step: ForkStep,
  ctx: FlowContext,
  options: FlowRunOptions,
  customText?: string,
): Promise<StepResult> {
  const agentConfig = step.agent
    ? options.getAgent(step.agent)
    : (options.getAgent("flow-decision") ?? FALLBACK_DECISION_AGENT);
  if (!agentConfig) return {};

  const branchNames = Object.keys(step.branches);
  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results, forks: ctx.forks,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  };

  let decisionTask = step.task
    ? expandTemplateVariables(step.task, templateCtx)
    : `The user was asked: "${step.question}"\nOptions: ${step.options.join(", ")}\nChoose the best option.`;

  // Enhance task with custom freetext context when provided
  if (customText) {
    decisionTask += `\n\nThe user typed a custom answer instead of picking an option: "${customText}"\nBased on their intent, choose the closest matching branch.`;
  }

  const result = await spawnAgent({
    agent: agentConfig,
    task: decisionTask,
    templateContext: templateCtx,
    getModelRole: options.getModelRole,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraGuardFactories: options.extraGuardFactories,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, agentConfig.tools),
    decisionBranches: branchNames,
    signal: options.signal,
  });

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
    results: ctx.results, forks: ctx.forks,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  });

  // ── Autonomous mode: auto-decide via agent (named agent, or built-in flow-decision) ──
  if (options.isAutonomous?.()) {
    return spawnForkDecisionAgent(step, ctx, options);
  }

  const extra: Record<string, boolean | Record<string, string>> = {};
  if (step.multiSelect) extra.multiSelect = true;
  if (step.allowCustom) extra.allowCustom = true;
  // Pass branch mapping and agent info for UI enhancement
  if (step.branches) extra.branches = step.branches;
  if (step.agent) extra.hasAutoAgent = true;

  const response = await options.askUser(expandedQuestion, "select", step.options, extra);

  // Handle auto-decide: user chose to let the agent decide this fork
  if (response.answer === "__auto_decide__" && step.agent) {
    return spawnForkDecisionAgent(step, ctx, options);
  }

  // Handle custom-decide: user typed freetext via "Other (describe)"
  if (response.answer === "__custom_decide__" && step.agent) {
    return spawnForkDecisionAgent(step, ctx, options, response.notes);
  }

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

  // Check if the resolved field is non-empty
  const target = field === "artifacts" ? result.artifacts
    : field === "summary" ? result.summary
    : field === "files" ? result.files
    : field === "status" ? result.status
    : result.fullOutput;
  const exists = target.trim().length > 0;
  return { nextStepId: exists ? step.present : step.absent };
}

async function executeAgentDecisionStep(step: AgentDecisionStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const agentConfig = options.getAgent(step.agent);
  if (!agentConfig) return {};

  const decisionConfig = { ...agentConfig };
  const branchNames = Object.keys(step.branches);

  const decisionTask = expandTemplateVariables(step.task, {
    task: ctx.task, inputs: {},
    results: ctx.results, forks: ctx.forks,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  });

  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results, forks: ctx.forks,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  };

  const skillContents = new Map<string, string>();
  if (decisionConfig.skills) {
    for (const skill of decisionConfig.skills) {
      const content = options.getSkillContent?.(skill);
      if (content) skillContents.set(skill, content);
    }
  }
  const contextFiles = options.getContextFiles?.(decisionConfig) ?? [];

  const result = await spawnAgent({
    agent: decisionConfig,
    task: decisionTask,
    templateContext: templateCtx,
    skillContents,
    contextFileContents: contextFiles,
    getModelRole: options.getModelRole,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraGuardFactories: options.extraGuardFactories,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, decisionConfig.tools),
    decisionBranches: branchNames,
    signal: options.signal,
  });

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
  // Increment iteration counter
  const iteration = (ctx.loopCounters[step.id] ?? 0) + 1;
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
    results: ctx.results, forks: ctx.forks,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  }) + `\n\nThis is iteration ${iteration} of ${step.max_iterations}.`;

  const templateCtx: TemplateContext = {
    task: ctx.task, inputs: {},
    results: ctx.results, forks: ctx.forks,
    loopCounters: ctx.loopCounters, loopMaxIterations: ctx.loopMaxIterations,
  };

  const skillContents = new Map<string, string>();
  if (decisionConfig.skills) {
    for (const skill of decisionConfig.skills) {
      const content = options.getSkillContent?.(skill);
      if (content) skillContents.set(skill, content);
    }
  }
  const contextFiles = options.getContextFiles?.(decisionConfig) ?? [];

  const result = await spawnAgent({
    agent: decisionConfig,
    task: decisionTask,
    templateContext: templateCtx,
    skillContents,
    contextFileContents: contextFiles,
    getModelRole: options.getModelRole,
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    extraGuardFactories: options.extraGuardFactories,
    extraCustomTools: filterExtensionTools(options.extraCustomTools, decisionConfig.tools),
    decisionBranches: ["loop", "exit"],
    signal: options.signal,
  });

  const branch = result.finishParams?.branch;
  if (branch === "loop") {
    return { nextStepId: step.loop_target, agentResult: result };
  }
  return { nextStepId: step.exit_target, agentResult: result };
}

async function executeFlowRefStep(step: FlowRefStep, ctx: FlowContext, options: FlowRunOptions): Promise<StepResult> {
  const expandedPath = expandTemplateVariables(step.path, {
    task: ctx.task, inputs: {},
    results: ctx.results, forks: ctx.forks,
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

  const nextStepId = lastAgentResult?.success ? step.on_complete : step.on_error;
  return { agentResult: lastAgentResult ?? undefined, nextStepId };
}

// ---- Helpers ---------------------------------------------------------------

function storeResult(ctx: FlowContext, stepId: string, result: AgentResult): void {
  ctx.results[stepId] = {
    fullOutput: result.output,
    status: result.result.status,
    summary: result.result.summary,
    artifacts: result.result.artifacts,
    files: result.result.files.map(f => `${f.path} (${f.action})`).join(", "),
    // Merge typed outputs from agent's declared outputs
    ...(result.typedOutputs ?? {}),
  };
}

function getLastResultOutput(ctx: FlowContext): string {
  const entries = Object.values(ctx.results);
  return entries.length > 0 ? entries[entries.length - 1].fullOutput : "";
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
