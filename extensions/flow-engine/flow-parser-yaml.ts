// ---------------------------------------------------------------------------
// Flow Parser (YAML) -- Parses .yaml flow files
//
// Uses the `yaml` npm package for correct YAML parsing. Maps parsed YAML
// objects to typed FlowStep/FlowConfig structures.
// ---------------------------------------------------------------------------

import type {
  FlowConfig,
  FlowStep,
  AgentStep,
  ForkStep,
  ConditionalStep,
  AgentDecisionStep,
  AgentLoopDecisionStep,
  FlowRefStep,
} from "./types.js";
import { readFileSync } from "node:fs";
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
    steps,
    source,
  };
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

  // Determine step type: explicit `type:` field or infer from fields
  const explicitType = raw.type as string | undefined;
  const stepType = explicitType || inferStepType(raw);

  switch (stepType) {
    case "agent": return parseAgentStep(raw, source);
    case "fork": return parseForkStep(raw, source);
    case "conditional": return parseConditionalStep(raw, source);
    case "agent-decision": return parseAgentDecisionStep(raw, source);
    case "agent-loop-decision": return parseAgentLoopDecisionStep(raw, source);
    case "flow-ref": return parseFlowRefStep(raw, source);
    default:
      throw new Error(`Unknown step type "${stepType}" for step "${id}": ${source}`);
  }
}

function inferStepType(raw: any): string {
  if (raw.loop_target) return "agent-loop-decision";
  if (raw.question) return "fork";
  if (raw.check) return "conditional";
  if (raw.path) return "flow-ref";
  if (raw.branches && !raw.question) return "agent-decision";
  if (raw.agent) return "agent";
  return "agent"; // default
}

function parseAgentStep(raw: any, source: string): AgentStep {
  const step: AgentStep = {
    stepType: "agent",
    id: raw.id,
    agent: requireString(raw, "agent", source),
  };

  if (raw.task) step.task = String(raw.task);
  if (raw.model) step.model = String(raw.model);
  if (raw.output) step.output = String(raw.output);
  if (raw.on_complete) step.on_complete = String(raw.on_complete);
  if (raw.on_error) step.on_error = String(raw.on_error);

  if (raw.blockedBy) {
    step.blockedBy = Array.isArray(raw.blockedBy)
      ? raw.blockedBy.map(String)
      : [String(raw.blockedBy)];
  }

  if (raw.reads) {
    step.reads = Array.isArray(raw.reads)
      ? raw.reads.map(String)
      : [String(raw.reads)];
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

  if (raw.branches && typeof raw.branches === "object") {
    for (const [k, v] of Object.entries(raw.branches)) {
      step.branches[k] = String(v);
    }
  }

  if (raw.allowNotes === true || raw.allowNotes === "true") step.allowNotes = true;
  if (raw.allowCustom === true || raw.allowCustom === "true") step.allowCustom = true;
  if (raw.multiSelect === true || raw.multiSelect === "true") step.multiSelect = true;
  if (raw.decisionAgent) step.decisionAgent = String(raw.decisionAgent);
  if (raw.agent) step.agent = String(raw.agent);
  if (raw.task) step.task = String(raw.task);

  return step;
}

function parseConditionalStep(raw: any, source: string): ConditionalStep {
  return {
    stepType: "conditional",
    id: raw.id,
    check: requireString(raw, "check", source),
    present: requireString(raw, "present", source),
    absent: requireString(raw, "absent", source),
  };
}

function parseAgentDecisionStep(raw: any, source: string): AgentDecisionStep {
  const branches: Record<string, string> = {};
  if (raw.branches && typeof raw.branches === "object") {
    for (const [k, v] of Object.entries(raw.branches)) {
      branches[k] = String(v);
    }
  }

  return {
    stepType: "agent-decision",
    id: raw.id,
    agent: requireString(raw, "agent", source),
    task: requireString(raw, "task", source),
    branches,
  };
}

function parseAgentLoopDecisionStep(raw: any, source: string): AgentLoopDecisionStep {
  return {
    stepType: "agent-loop-decision",
    id: raw.id,
    agent: requireString(raw, "agent", source),
    task: requireString(raw, "task", source),
    loop_target: requireString(raw, "loop_target", source),
    exit_target: requireString(raw, "exit_target", source),
    max_iterations: toInt(raw.max_iterations, source),
  };
}

function parseFlowRefStep(raw: any, source: string): FlowRefStep {
  const step: FlowRefStep = {
    stepType: "flow-ref",
    id: raw.id,
    path: requireString(raw, "path", source),
  };

  if (raw.on_complete) step.on_complete = String(raw.on_complete);
  if (raw.on_error) step.on_error = String(raw.on_error);

  return step;
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
