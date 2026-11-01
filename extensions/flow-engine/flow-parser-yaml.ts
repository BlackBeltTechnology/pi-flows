// ---------------------------------------------------------------------------
// Flow Parser (YAML) -- Parses .yaml flow files
//
// Uses the `yaml` npm package for correct YAML parsing. Maps parsed YAML
// objects to typed FlowStep/FlowConfig structures.
// ---------------------------------------------------------------------------

import type {
  FlowConfig,
  FlowInputDecl,
  FlowStep,
  AgentStep,
  CodeStep,
  CodeDecisionStep,
  ForkStep,
  AgentDecisionStep,
} from "./types.js";
import { readFileSync } from "node:fs";
import { parseDeciderSpec } from "./decider/chain.js";
import { parse as parseYaml } from "yaml";

// ---- Public API ------------------------------------------------------------

/**
 * Parse a .yaml flow file from disk.
 */
export function parseFlowYamlFile(filePath: string): FlowConfig {
  const content = readFileSync(filePath, "utf-8");
  return parseFlowYamlString(content, filePath);
}

/**
 * Parse a .yaml flow string directly.
 */
export function parseFlowYamlString(content: string, source: string): FlowConfig {
  const doc = parseYaml(content);

  if (!doc || typeof doc !== "object") {
    throw new Error(`Flow YAML is empty or not a mapping: ${source}`);
  }

  const name = requireString(doc, "name", source);
  const description = requireString(doc, "description", source);
  const max_concurrent = doc.max_concurrent !== undefined ? toInt(doc.max_concurrent, source) : undefined;
  const task_required = doc.task_required === true || doc.task_required === "true";
  const task_prompt = doc.task_prompt ? String(doc.task_prompt) : undefined;
  const inputs = parseFlowInputs(doc.inputs, source);

  const rawSteps = doc.steps;
  if (!Array.isArray(rawSteps)) {
    throw new Error(`Flow YAML must have a "steps" array: ${source}`);
  }

  const steps: FlowStep[] = rawSteps.map((raw: any, i: number) => parseStep(raw, i, source));

  return {
    name,
    description,
    ...(max_concurrent !== undefined ? { max_concurrent } : {}),
    ...(task_required ? { task_required } : {}),
    ...(task_prompt ? { task_prompt } : {}),
    ...(inputs ? { inputs } : {}),
    ...(doc.decision_agent ? { decision_agent: String(doc.decision_agent) } : {}),
    ...(doc.decider !== undefined ? { decider: parseDecider(doc.decider, source) } : {}),
    steps,
    source,
  };
}

const VALID_INPUT_TYPES = new Set(["string", "number", "boolean", "object", "array"]);

/** Parse the optional flow-level `inputs:` schema. (flow-typed-io-and-run-state) */
function parseFlowInputs(raw: any, source: string): Record<string, FlowInputDecl> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Flow "inputs" must be a mapping of name -> { type, required? }: ${source}`);
  }
  const out: Record<string, FlowInputDecl> = {};
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    const t = v?.type;
    if (!t || typeof t !== "string" || !VALID_INPUT_TYPES.has(t)) {
      throw new Error(`Flow input "${k}" needs a valid "type" (string|number|boolean|object|array): ${source}`);
    }
    out[k] = { type: t as FlowInputDecl["type"], ...(v.required === true ? { required: true } : {}) };
  }
  return out;
}

// ---- Step parsing ----------------------------------------------------------

function parseStep(raw: any, index: number, source: string): FlowStep {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Step ${index} is not an object: ${source}`);
  }

  const id = raw.id;
  if (!id || typeof id !== "string") {
    throw new Error(`Step ${index} missing "id" field: ${source}`);
  }

  // Every step MUST declare its type explicitly; the parser does not infer.
  const stepType = raw.type as string | undefined;
  if (!stepType || typeof stepType !== "string") {
    throw new Error(
      `Step "${id}" missing required "type" field. ` +
      `Declare one of: agent, agent-decision, code, code-decision, fork: ${source}`,
    );
  }

  // Removed step types: actionable migration errors (see unify-decision-routing).
  if (stepType === "conditional") {
    throw new Error(
      `Step "${id}": step type "conditional" was removed. Replace with type: code-decision — ` +
      `read the checked value as a handler input and return { branch: "present" } or { branch: "absent" }, ` +
      `with branches: { present: <present-target>, absent: <absent-target> }: ${source}`,
    );
  }
  if (stepType === "agent-loop-decision") {
    throw new Error(
      `Step "${id}": step type "agent-loop-decision" was removed. Replace with type: agent-decision — ` +
      `move loop_target and exit_target into branches: (e.g. branches: { rework: <loop_target>, done: <exit_target> }) ` +
      `and keep max_iterations: ${source}`,
    );
  }

  switch (stepType) {
    case "agent": return parseAgentStep(raw, source);
    case "code": return parseCodeStep(raw, source);
    case "code-decision": return parseCodeDecisionStep(raw, source);
    case "fork": return parseForkStep(raw, source);
    case "agent-decision": return parseAgentDecisionStep(raw, source);
    default:
      throw new Error(`Unknown step type "${stepType}" for step "${id}": ${source}`);
  }
}

function parseAgentStep(raw: any, source: string): AgentStep {
  const step: AgentStep = {
    stepType: "agent",
    id: raw.id,
    agent: requireString(raw, "agent", source),
  };

  if (raw.task) step.task = String(raw.task);
  if (raw.output) step.output = String(raw.output);
  if (raw.on_error) step.on_error = String(raw.on_error);

  if (raw.blockedBy) {
    step.blockedBy = Array.isArray(raw.blockedBy)
      ? raw.blockedBy.map(String)
      : [String(raw.blockedBy)];
  }

  if (raw.inputs && typeof raw.inputs === "object") {
    step.inputs = {};
    for (const [k, v] of Object.entries(raw.inputs)) {
      step.inputs[k] = String(v);
    }
  }

  return step;
}

function parseForkStep(raw: any, source: string): ForkStep {
  const step: ForkStep = {
    stepType: "fork",
    id: raw.id,
    question: requireString(raw, "question", source),
    options: Array.isArray(raw.options)
      ? raw.options.map(String)
      : [String(raw.options)],
    branches: {},
  };

  const fb = parseBranches(raw.branches, raw.id, source);
  step.branches = fb.branches;
  if (fb.branchMeans) step.branchMeans = fb.branchMeans;
  if (raw.decider !== undefined) step.decider = parseDecider(raw.decider, source);
  const forkState = parseState(raw.state, raw.id, source);
  if (forkState) step.state = forkState;

  if (raw.allowCustom === true || raw.allowCustom === "true") step.allowCustom = true;
  if (raw.multiSelect === true || raw.multiSelect === "true") step.multiSelect = true;
  if (raw.agent) step.agent = String(raw.agent);
  if (raw.task) step.task = String(raw.task);

  return step;
}

function parseAgentDecisionStep(raw: any, source: string): AgentDecisionStep {
  const { branches, branchMeans } = parseBranches(raw.branches, raw.id, source);

  const step: AgentDecisionStep = {
    stepType: "agent-decision",
    id: raw.id,
    task: requireString(raw, "task", source),
    branches,
  };
  if (branchMeans) step.branchMeans = branchMeans;
  if (raw.agent) step.agent = String(raw.agent);
  if (raw.decider !== undefined) step.decider = parseDecider(raw.decider, source);
  const state = parseState(raw.state, raw.id, source);
  if (state) step.state = state;
  if (raw.max_iterations !== undefined) step.max_iterations = toInt(raw.max_iterations, source);
  return step;
}

function parseCodeDecisionStep(raw: any, source: string): CodeDecisionStep {
  const { branches, branchMeans } = parseBranches(raw.branches, raw.id, source);

  const step: CodeDecisionStep = {
    stepType: "code-decision",
    id: raw.id,
    branches,
  };
  if (branchMeans) step.branchMeans = branchMeans;

  if (raw.target) step.target = String(raw.target);
  if (raw.max_iterations !== undefined) step.max_iterations = toInt(raw.max_iterations, source);
  if (raw.timeout !== undefined) step.timeout = toInt(raw.timeout, source);

  if (raw.blockedBy) {
    step.blockedBy = Array.isArray(raw.blockedBy)
      ? raw.blockedBy.map(String)
      : [String(raw.blockedBy)];
  }

  if (raw.inputs && typeof raw.inputs === "object") {
    step.inputs = {};
    for (const [k, v] of Object.entries(raw.inputs)) {
      step.inputs[k] = String(v);
    }
  }

  if (raw.outputs && Array.isArray(raw.outputs)) {
    step.outputs = raw.outputs.map((output: any) => ({
      name: typeof output === "string" ? output : String(output.name ?? output),
    }));
  }

  return step;
}

function parseCodeStep(raw: any, source: string): CodeStep {
  const step: CodeStep = {
    stepType: "code",
    id: raw.id,
  };

  if (raw.target) step.target = String(raw.target);
  if (raw.on_error) step.on_error = String(raw.on_error);
  if (raw.timeout !== undefined) step.timeout = toInt(raw.timeout, source);

  if (raw.blockedBy) {
    step.blockedBy = Array.isArray(raw.blockedBy)
      ? raw.blockedBy.map(String)
      : [String(raw.blockedBy)];
  }

  if (raw.inputs && typeof raw.inputs === "object") {
    step.inputs = {};
    for (const [k, v] of Object.entries(raw.inputs)) {
      step.inputs[k] = String(v);
    }
  }

  if (raw.outputs && Array.isArray(raw.outputs)) {
    step.outputs = raw.outputs.map((output: any) => ({
      name: typeof output === "string" ? output : String(output.name ?? output),
    }));
  }

  return step;
}

// ---- Decision helpers (classifier-decisions) -------------------------------

/** Branch values: a target stepId string, or `{ to, means }` (normalised). */
function parseBranches(
  raw: any,
  stepId: string,
  source: string,
): { branches: Record<string, string>; branchMeans?: Record<string, string> } {
  const branches: Record<string, string> = {};
  const means: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const to = (v as any).to;
        if (to === undefined || to === null || String(to) === "") {
          throw new Error(`Step "${stepId}": branch "${k}" object form needs a "to" target ({ to: <step>, means: <text> }): ${source}`);
        }
        branches[k] = String(to);
        const m = (v as any).means;
        if (m !== undefined && m !== null && String(m) !== "") means[k] = String(m);
      } else {
        branches[k] = String(v);
      }
    }
  }
  return { branches, ...(Object.keys(means).length ? { branchMeans: means } : {}) };
}

function parseDecider(raw: any, source: string) {
  try {
    return parseDeciderSpec(raw);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)}: ${source}`, { cause: err });
  }
}

function parseState(raw: any, stepId: string, source: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Step "${stepId}": "state" must be a mapping of name -> value: ${source}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = String(v);
  return out;
}

// ---- Utility ---------------------------------------------------------------

function requireString(obj: any, key: string, source: string): string {
  const val = obj[key];
  if (val === undefined || val === null) {
    throw new Error(`Flow YAML missing required field "${key}": ${source}`);
  }
  return String(val);
}

function toInt(val: any, source: string): number {
  const n = parseInt(String(val), 10);
  if (isNaN(n)) {
    throw new Error(`Expected integer but got "${val}": ${source}`);
  }
  return n;
}
