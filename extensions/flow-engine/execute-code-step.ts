/**
 * Code node executor — runs a TypeScript handler module as a DAG step.
 *
 * Implements the code step execution contract from the add-code-node spec:
 * - Resolves handler path (convention or explicit target)
 * - Expands input templates
 * - Imports the handler via dynamic import (pi's jiti handles .ts at runtime)
 * - Validates & coerces the returned outputs
 * - Maps result to AgentResult
 * - Implements soft-timeout
 * - Routes FlowHardError as hard failure; everything else as soft failure
 */

import type { CodeStep, CodeDecisionStep, AgentResult, CodeNodeContext, FailureInfo, NodeKind } from "./types.js";
import { classifyThrownError } from "./failure.js";
import { expandTemplateVariables } from "./execution.js";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

// ---- Lean interfaces (avoids circular imports with flow-execution.ts) -------

/** The parts of FlowContext the executor needs. */
export interface CodeNodeFlowCtx {
  task: string;
  results: Record<string, {
    fullOutput: string;
    status: string;
    summary: string;
    artifacts: string;
    files: string;
    [key: string]: string;
  }>;
  loopCounters: Record<string, number>;
  loopMaxIterations: Record<string, number>;
}

/** The parts of FlowRunOptions the executor needs. */
export interface CodeNodeExecOptions {
  cwd: string;
  signal?: AbortSignal;
  onAgentStarted?: (agentName: string, stepId: string, resolvedModel?: string, extra?: { nodeKind?: NodeKind; target?: string }) => void;
  onAgentComplete?: (agentName: string, stepId: string, result: AgentResult, extra?: { nodeKind?: NodeKind; target?: string }) => void;
  onAssistantText?: (agentName: string, stepId: string, text: string) => void;
}

// ---- Main executor ---------------------------------------------------------

export async function executeCodeStep(
  step: CodeStep | CodeDecisionStep,
  ctx: CodeNodeFlowCtx,
  options: CodeNodeExecOptions,
  flowName: string,
): Promise<AgentResult> {
  // A `code-decision` node runs identically to `code` but reserves a `branch`
  // output for routing. Tag lifecycle events with its kind and allow `branch`
  // through the otherwise-strict undeclared-key check.
  const isDecision = step.stepType === "code-decision";
  const nodeKind: NodeKind = isDecision ? "code-decision" : "code";
  // ── Resolve handler path ─────────────────────────────────────────────────
  let handlerPath: string;
  if (step.target) {
    handlerPath = resolve(options.cwd, step.target);
  } else {
    handlerPath = join(options.cwd, ".pi", "flows", "handlers", flowName, `${step.id}.ts`);
  }
  // Lifecycle `extra`: the node's kind drives card rendering; `target` lets a
  // live/replayed code card show which handler ran. Reused across all
  // started/complete callbacks below.
  const lifecycle = { nodeKind, target: handlerPath };

  // ── Lifecycle: started ────────────────────────────────────────────────────
  options.onAgentStarted?.(step.id, step.id, undefined, lifecycle);

  // ── Missing handler check ────────────────────────────────────────────────
  if (!existsSync(handlerPath)) {
    const templatePath = step.target
      ? handlerPath + ".default"
      : join(options.cwd, ".pi", "flows", "handlers", flowName, `${step.id}.ts.default`);
    const missingResult = makeSoftFailure(
      `Code node "${step.id}": handler file not found at "${handlerPath}".\n` +
      `Copy the template and implement the default export:\n` +
      `  cp "${templatePath}" "${handlerPath}"\n` +
      `Then implement the default export function.`,
    );
    options.onAgentComplete?.(step.id, step.id, missingResult, lifecycle);
    return missingResult;
  }

  // ── Build inputs via template expansion ──────────────────────────────────
  const templateCtx = {
    task: ctx.task,
    inputs: {} as Record<string, string>,
    results: ctx.results,
    loopCounters: ctx.loopCounters,
    loopMaxIterations: ctx.loopMaxIterations,
  };
  const input: Record<string, string> = {};
  if (step.inputs) {
    for (const [key, template] of Object.entries(step.inputs)) {
      input[key] = expandTemplateVariables(template, templateCtx);
    }
  }

  // ── Build CodeNodeContext ─────────────────────────────────────────────────
  let summaryValue: string | undefined;
  const nodeController = new AbortController();

  // Propagate outer abort signal
  if (options.signal) {
    if (options.signal.aborted) {
      nodeController.abort();
    } else {
      options.signal.addEventListener("abort", () => nodeController.abort(), { once: true });
    }
  }

  const codeCtx: CodeNodeContext = {
    signal: nodeController.signal,
    cwd: options.cwd,
    logger: (msg: string) => { options.onAssistantText?.(step.id, step.id, msg); },
    setSummary: (text: string) => { summaryValue = text; },
    flowName,
    stepId: step.id,
    task: ctx.task,
  };

  // ── Import handler module ─────────────────────────────────────────────────
  let handlerModule: any;
  try {
    handlerModule = await import(handlerPath);
  } catch (err) {
    const importErr = makeSoftFailure(
      `Code node "${step.id}": failed to import handler "${handlerPath}": ${(err as Error).message}`,
    );
    options.onAgentComplete?.(step.id, step.id, importErr, lifecycle);
    return importErr;
  }

  const handler = handlerModule.default;
  if (typeof handler !== "function") {
    const noExportErr = makeSoftFailure(
      `Code node "${step.id}": handler has no default export function (got ${typeof handler})`,
    );
    options.onAgentComplete?.(step.id, step.id, noExportErr, lifecycle);
    return noExportErr;
  }

  // ── Execute with optional soft timeout ────────────────────────────────────
  let rawReturn: unknown;
  try {
    rawReturn = await executeWithTimeout(handler, input, codeCtx, step, nodeController);
  } catch (err: any) {
    // Timeout is a SOFT deadline; a thrown FlowHardError classifies HARD,
    // any other throw classifies SOFT (per node-failure-model).
    let info: FailureInfo;
    if (err?.isTimeout) {
      info = { outcome: "soft", message: `Code node "${step.id}": timeout after ${step.timeout}ms`, source: "code_timeout" };
    } else {
      const base = classifyThrownError(err);
      info = { ...base, message: `Code node "${step.id}": handler threw: ${base.message}` };
    }
    const throwResult = makeFailure(info);
    options.onAgentComplete?.(step.id, step.id, throwResult, lifecycle);
    return throwResult;
  }

  // ── Validate and coerce outputs ───────────────────────────────────────────
  const declaredNames = (step.outputs ?? []).map((o) => o.name);
  const returned = rawReturn as Record<string, unknown>;
  const typedOutputs: Record<string, string> = {};

  // code-decision: pull the reserved `branch` routing key out before data-output
  // validation. It is required, must be a string, and is never a declared data
  // output. The resolved branch travels to the router via finishParams.branch.
  let decisionBranch: string | undefined;
  if (isDecision) {
    const rawBranch = returned.branch;
    if (rawBranch === undefined || rawBranch === null) {
      const missingBranch = makeSoftFailure(`Code node "${step.id}": missing reserved "branch" output (a code-decision handler must return { branch: ... })`);
      options.onAgentComplete?.(step.id, step.id, missingBranch, lifecycle);
      return missingBranch;
    }
    if (typeof rawBranch !== "string") {
      const badBranch = makeSoftFailure(`Code node "${step.id}": reserved "branch" output must be a string (got ${typeof rawBranch})`);
      options.onAgentComplete?.(step.id, step.id, badBranch, lifecycle);
      return badBranch;
    }
    decisionBranch = rawBranch;
  }

  // All declared keys must be present
  for (const name of declaredNames) {
    if (!(name in returned)) {
      const contractErr = makeSoftFailure(`Code node "${step.id}": missing declared output "${name}"`);
      options.onAgentComplete?.(step.id, step.id, contractErr, lifecycle);
      return contractErr;
    }
  }

  // No undeclared extra keys (the reserved `branch` key is allowed on code-decision)
  for (const key of Object.keys(returned)) {
    if (key === "branch" && isDecision) continue;
    if (!declaredNames.includes(key)) {
      const extraErr = makeSoftFailure(`Code node "${step.id}": undeclared output key "${key}" — remove it or add it to outputs:`);
      options.onAgentComplete?.(step.id, step.id, extraErr, lifecycle);
      return extraErr;
    }
  }

  // Coerce each declared output value
  for (const name of declaredNames) {
    const val = returned[name];
    const t = typeof val;
    if (t === "string") {
      typedOutputs[name] = val as string;
    } else if (t === "number" || t === "boolean" || t === "bigint") {
      typedOutputs[name] = String(val);
    } else {
      const vkind = val === null ? "null" : Array.isArray(val) ? "array" : "object";
      const coerceErr = makeSoftFailure(`Code node "${step.id}": output "${name}" must be a string or primitive value (got ${vkind}); use JSON.stringify() to serialize`);
      options.onAgentComplete?.(step.id, step.id, coerceErr, lifecycle);
      return coerceErr;
    }
  }

  // ── Build AgentResult ─────────────────────────────────────────────────────
  const summary =
    summaryValue ??
    (declaredNames.length > 0
      ? `Code node ${step.id} completed with outputs: ${declaredNames.join(", ")}`
      : `Code node ${step.id} completed`);

  const successResult: AgentResult = {
    success: true,
    output: JSON.stringify(typedOutputs),
    stderr: "",
    exitCode: 0,
    result: {
      status: "complete",
      files: [],
      artifacts: "",
      summary,
    },
    toolCalls: [],
    duration: 0,
    tokens: { input: 0, output: 0 },
    typedOutputs,
    outcome: "success",
    // code-decision surfaces its chosen branch to the router the same way an
    // agent-decision does (via finishParams.branch); data outputs stay separate.
    ...(decisionBranch !== undefined ? { finishParams: { branch: decisionBranch } } : {}),
  };
  options.onAgentComplete?.(step.id, step.id, successResult, lifecycle);
  return successResult;
}

// ---- Helpers ---------------------------------------------------------------

async function executeWithTimeout(
  handler: Function,
  input: Record<string, string>,
  codeCtx: CodeNodeContext,
  step: CodeStep | CodeDecisionStep,
  nodeController: AbortController,
): Promise<unknown> {
  const handlerPromise = (handler as (i: any, c: any) => Promise<unknown>)(input, codeCtx);

  if (step.timeout === undefined) return handlerPromise;

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      nodeController.abort();
      const err = new Error(`timeout`) as any;
      err.isTimeout = true;
      reject(err);
    }, step.timeout);

    handlerPromise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function makeSoftFailure(message: string, source = "code_node"): AgentResult {
  return makeFailure({ outcome: "soft", message, source });
}

/**
 * Build a failed AgentResult carrying the node-failure-model outcome
 * (`soft` or `hard`) so the DAG scheduler routes/halts via resolveRouteOutcome.
 */
function makeFailure(info: FailureInfo): AgentResult {
  return {
    success: false,
    output: info.message,
    stderr: "",
    exitCode: 1,
    result: {
      status: "error",
      files: [],
      artifacts: "",
      summary: info.message,
    },
    toolCalls: [],
    duration: 0,
    tokens: { input: 0, output: 0 },
    outcome: info.outcome,
    failureInfo: info,
  };
}
