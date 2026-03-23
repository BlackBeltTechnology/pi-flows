// ---------------------------------------------------------------------------
// Flow Parser -- Parses .flow.md files with YAML frontmatter and step sections
//
// No external YAML library. Manual parsing of frontmatter and step definitions.
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

// ---- Public API ------------------------------------------------------------

/**
 * Parse a .flow.md file from disk.
 */
export function parseFlowFile(filePath: string): FlowConfig {
  const content = readFileSync(filePath, "utf-8");
  return parseFlowString(content, filePath);
}

/**
 * Parse a .flow.md string directly.
 * @param content  Raw markdown string
 * @param source   File path (for diagnostics and the `source` field)
 */
export function parseFlowString(content: string, source: string): FlowConfig {
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = parseFrontmatter(frontmatter);

  const name = expectString(meta, "name", source);
  const description = expectString(meta, "description", source);
  const max_concurrent =
    meta.max_concurrent !== undefined
      ? toInt(meta.max_concurrent, "max_concurrent", source)
      : undefined;

  const steps = parseSteps(body, source);

  // Validate: reject group: usage (removed in DAG-first change)
  for (const step of steps) {
    if (step.stepType === "agent" && (step as any)._hasGroup) {
      throw new Error(`Step "${step.id}" uses "group:" which is no longer supported. Use blockedBy: for dependencies. (${source})`);
    }
  }

  // Validate: blockedBy references must be within the same DAG segment
  validateSegmentBlockedBy(steps, source);

  return {
    name,
    description,
    ...(max_concurrent !== undefined ? { max_concurrent } : {}),
    steps,
    source,
  };
}

// ---- Frontmatter -----------------------------------------------------------

interface FrontmatterResult {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(content: string): FrontmatterResult {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: "", body: content };
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error("Flow file has unclosed frontmatter (missing closing ---)");
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4); // skip past "\n---"
  return { frontmatter, body };
}

/**
 * Minimal YAML-subset parser. Handles:
 *   key: value          (string / number)
 *   key: value1, value2 (inline list)
 *   key:                (block list follows)
 *     - item
 */
function parseFrontmatter(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  if (!raw) return result;

  const lines = raw.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    // Skip blank lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // List item continuation (indented "- value")
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listItemMatch && currentKey && currentList) {
      currentList.push(listItemMatch[1].trim());
      continue;
    }

    // Flush any pending list
    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    // Key: value pair
    const kvMatch = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value === "") {
      // Block list follows
      currentKey = key;
      currentList = [];
    } else if (value.includes(",")) {
      // Inline list
      result[key] = value.split(",").map((s) => s.trim());
    } else {
      result[key] = value;
    }
  }

  // Flush trailing list
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

// ---- Step parsing ----------------------------------------------------------

/**
 * Split the body into step blocks delimited by `## ` headers, then parse each.
 */
function parseSteps(body: string, source: string): FlowStep[] {
  const steps: FlowStep[] = [];
  const blocks = splitStepBlocks(body);

  for (const block of blocks) {
    steps.push(parseStepBlock(block.header, block.body, source));
  }

  return steps;
}

interface StepBlock {
  header: string; // The text after "## "
  body: string; // Lines below the header until the next header
}

function splitStepBlocks(body: string): StepBlock[] {
  const blocks: StepBlock[] = [];
  const lines = body.split("\n");
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      // Flush previous block
      if (currentHeader !== null) {
        blocks.push({ header: currentHeader, body: currentLines.join("\n") });
      }
      currentHeader = headerMatch[1].trim();
      currentLines = [];
    } else if (currentHeader !== null) {
      currentLines.push(line);
    }
  }

  // Flush last block
  if (currentHeader !== null) {
    blocks.push({ header: currentHeader, body: currentLines.join("\n") });
  }

  return blocks;
}

/**
 * Determine step type from the header prefix, then delegate to the appropriate parser.
 */
function parseStepBlock(
  header: string,
  body: string,
  source: string,
): FlowStep {
  if (header.startsWith("fork:")) {
    return parseForkStep(header, body, source);
  }
  if (header.startsWith("conditional:")) {
    return parseConditionalStep(header, body, source);
  }
  if (header.startsWith("agent-decision:")) {
    return parseAgentDecisionStep(header, body, source);
  }
  if (header.startsWith("agent-loop-decision:")) {
    return parseAgentLoopDecisionStep(header, body, source);
  }
  if (header.startsWith("flow-ref:")) {
    return parseFlowRefStep(header, body, source);
  }
  // Default: AgentStep
  return parseAgentStep(header, body, source);
}

// ---- AgentStep -------------------------------------------------------------

function parseAgentStep(
  header: string,
  body: string,
  source: string,
): AgentStep {
  const props = parseProperties(body);
  const id = header;
  const step: AgentStep = {
    stepType: "agent",
    id,
    agent: id,
  };

  if (props.task) step.task = props.task;
  if (props.model) step.model = props.model;
  if (props.output) step.output = props.output;
  if (props.on_complete) step.on_complete = props.on_complete;
  if (props.on_error) step.on_error = props.on_error;

  if (props.reads) {
    step.reads = toList(props.reads);
  }

  // Reject group: usage
  if (props.group) {
    throw new Error(`Step "${id}" uses "group:" which is no longer supported. Use blockedBy: for dependencies. (${source})`);
  }

  if (props.blockedBy) {
    step.blockedBy = toList(props.blockedBy);
  }

  // Parse inputs: block (nested key:value like branches)
  if (props.inputs && typeof props.inputs === "object" && !Array.isArray(props.inputs)) {
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(props.inputs)) {
      inputs[k] = String(v);
    }
    step.inputs = inputs;
  }

  return step;
}

// ---- ForkStep --------------------------------------------------------------

function parseForkStep(
  header: string,
  body: string,
  source: string,
): ForkStep {
  const id = header.slice("fork:".length).trim();
  const props = parseProperties(body);

  if (!props.question) {
    throw new Error(
      `ForkStep "${id}" missing required "question" in ${source}`,
    );
  }
  if (!props.options) {
    throw new Error(
      `ForkStep "${id}" missing required "options" in ${source}`,
    );
  }

  const step: ForkStep = {
    stepType: "fork",
    id,
    question: props.question,
    options: toList(props.options),
    branches: parseBranches(props, source),
  };

  if (props.allowNotes === "true") step.allowNotes = true;
  if (props.allowCustom === "true") step.allowCustom = true;
  if (props.multiSelect === "true") step.multiSelect = true;
  if (props.decisionAgent) step.decisionAgent = props.decisionAgent;

  return step;
}

// ---- ConditionalStep -------------------------------------------------------

function parseConditionalStep(
  header: string,
  body: string,
  source: string,
): ConditionalStep {
  const id = header.slice("conditional:".length).trim();
  const props = parseProperties(body);

  if (!props.check) {
    throw new Error(
      `ConditionalStep "${id}" missing required "check" in ${source}`,
    );
  }
  if (!props.present) {
    throw new Error(
      `ConditionalStep "${id}" missing required "present" in ${source}`,
    );
  }
  if (!props.absent) {
    throw new Error(
      `ConditionalStep "${id}" missing required "absent" in ${source}`,
    );
  }

  return {
    stepType: "conditional",
    id,
    check: props.check,
    present: props.present,
    absent: props.absent,
  };
}

// ---- AgentDecisionStep -----------------------------------------------------

function parseAgentDecisionStep(
  header: string,
  body: string,
  source: string,
): AgentDecisionStep {
  const id = header.slice("agent-decision:".length).trim();
  const props = parseProperties(body);

  if (!props.agent) {
    throw new Error(
      `AgentDecisionStep "${id}" missing required "agent" in ${source}`,
    );
  }
  if (!props.task) {
    throw new Error(
      `AgentDecisionStep "${id}" missing required "task" in ${source}`,
    );
  }

  const branches = parseBranches(props, source);
  if (Object.keys(branches).length === 0) {
    throw new Error(
      `AgentDecisionStep "${id}" missing required "branches" in ${source}`,
    );
  }

  return {
    stepType: "agent-decision",
    id,
    agent: props.agent,
    task: props.task,
    branches,
  };
}

// ---- AgentLoopDecisionStep -------------------------------------------------

function parseAgentLoopDecisionStep(
  header: string,
  body: string,
  source: string,
): AgentLoopDecisionStep {
  const id = header.slice("agent-loop-decision:".length).trim();
  const props = parseProperties(body);

  if (!props.agent) {
    throw new Error(
      `AgentLoopDecisionStep "${id}" missing required "agent" in ${source}`,
    );
  }
  if (!props.task) {
    throw new Error(
      `AgentLoopDecisionStep "${id}" missing required "task" in ${source}`,
    );
  }
  if (!props.loop_target) {
    throw new Error(
      `AgentLoopDecisionStep "${id}" missing required "loop_target" in ${source}`,
    );
  }
  if (!props.exit_target) {
    throw new Error(
      `AgentLoopDecisionStep "${id}" missing required "exit_target" in ${source}`,
    );
  }
  if (!props.max_iterations) {
    throw new Error(
      `AgentLoopDecisionStep "${id}" missing required "max_iterations" in ${source}`,
    );
  }

  return {
    stepType: "agent-loop-decision",
    id,
    agent: props.agent,
    task: props.task,
    loop_target: props.loop_target,
    exit_target: props.exit_target,
    max_iterations: toInt(props.max_iterations, "max_iterations", source),
  };
}

// ---- FlowRefStep -----------------------------------------------------------

function parseFlowRefStep(
  header: string,
  body: string,
  source: string,
): FlowRefStep {
  const path = header.slice("flow-ref:".length).trim();
  const props = parseProperties(body);

  const step: FlowRefStep = {
    stepType: "flow-ref",
    id: path,
    path,
  };

  if (props.on_complete) step.on_complete = props.on_complete;
  if (props.on_error) step.on_error = props.on_error;

  return step;
}

// ---- Property parsing helpers ----------------------------------------------

/**
 * Parse the body of a step block into key-value properties.
 * Handles simple `key: value` lines and indented `key:\n  subkey: value` blocks.
 */
function parseProperties(body: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = body.split("\n");
  let currentBlock: string | null = null;
  let blockContent: Record<string, string> = {};
  // Multiline scalar state (YAML > and | syntax)
  let multilineKey: string | null = null;
  let multilineMode: ">" | "|" | null = null;
  let multilineLines: string[] = [];

  for (const line of lines) {
    // Multiline scalar continuation: collect indented lines
    if (multilineKey) {
      if (line.match(/^\s{2,}/) && line.trim() !== "") {
        multilineLines.push(line.replace(/^\s{2,}/, ""));
        continue;
      }
      if (line.trim() === "") {
        // Empty line within multiline block → paragraph break
        multilineLines.push("");
        continue;
      }
      // Non-indented, non-empty line → flush multiline
      if (multilineMode === ">") {
        result[multilineKey] = flushFolded(multilineLines);
      } else {
        result[multilineKey] = multilineLines.filter((_, i, a) => !(i === a.length - 1 && a[i] === "")).join("\n");
      }
      multilineKey = null;
      multilineMode = null;
      multilineLines = [];
      // Fall through to process the current line normally
    }

    // Skip empty lines
    if (line.trim() === "") continue;

    // Indented line (part of a block)
    const indentedMatch = line.match(/^\s{2,}(\S[\w-]*):\s*(.+)$/);
    if (indentedMatch && currentBlock) {
      blockContent[indentedMatch[1]] = indentedMatch[2].trim();
      continue;
    }

    // Flush previous block
    if (currentBlock) {
      result[currentBlock] = blockContent;
      currentBlock = null;
      blockContent = {};
    }

    // Top-level key: value
    const kvMatch = line.match(/^(\S[\w_]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value === ">" || value === "|") {
      // Start of a multiline scalar block
      multilineKey = key;
      multilineMode = value as ">" | "|";
      multilineLines = [];
    } else if (value === "") {
      // Start of a nested block
      currentBlock = key;
      blockContent = {};
    } else {
      result[key] = value;
    }
  }

  // Flush trailing multiline
  if (multilineKey) {
    if (multilineMode === ">") {
      result[multilineKey] = flushFolded(multilineLines);
    } else {
      result[multilineKey] = multilineLines.filter((_, i, a) => !(i === a.length - 1 && a[i] === "")).join("\n");
    }
  }

  // Flush trailing block
  if (currentBlock) {
    result[currentBlock] = blockContent;
  }

  return result;
}

/** Join folded scalar lines: consecutive non-empty lines joined with spaces, empty lines become newlines. */
function flushFolded(lines: string[]): string {
  // Remove trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

/**
 * Extract branches from properties.
 */
function parseBranches(
  props: Record<string, any>,
  source: string,
): Record<string, string> {
  const raw = props.branches;
  if (!raw) return {};

  if (typeof raw === "object" && !Array.isArray(raw)) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      result[k] = String(v);
    }
    return result;
  }

  if (typeof raw === "string") {
    const result: Record<string, string> = {};
    for (const pair of raw.split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (k && v) result[k] = v;
    }
    return result;
  }

  return {};
}

/**
 * Convert a value to a string list.
 */
function toList(value: any): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// ---- Segment validation ----------------------------------------------------

/**
 * Validate that all blockedBy references point to steps within the same DAG segment.
 */
function validateSegmentBlockedBy(steps: FlowStep[], source: string): void {
  let segmentStepIds = new Set<string>();

  for (const step of steps) {
    if (step.stepType !== "agent") {
      segmentStepIds = new Set<string>();
      continue;
    }

    segmentStepIds.add(step.id);
    const agentStep = step as AgentStep;
    if (agentStep.blockedBy) {
      for (const ref of agentStep.blockedBy) {
        if (!segmentStepIds.has(ref)) {
          const allStepIds = new Set(steps.filter(s => s.stepType === "agent").map(s => s.id));
          if (allStepIds.has(ref)) {
            throw new Error(
              `Step "${step.id}" has blockedBy: "${ref}" which is in a different DAG segment. Use inputs: with {result.${ref}} for cross-segment data flow. (${source})`
            );
          }
        }
      }
    }
  }
}

// ---- Validation helpers ----------------------------------------------------

function expectString(
  obj: Record<string, any>,
  key: string,
  source: string,
): string {
  const val = obj[key];
  if (val === undefined || val === null || val === "") {
    throw new Error(
      `Flow file missing required field "${key}" in frontmatter (${source})`,
    );
  }
  return String(val);
}


function toInt(value: any, key: string, source: string): number {
  const n = parseInt(String(value), 10);
  if (isNaN(n)) {
    throw new Error(
      `Flow file field "${key}" must be an integer, got "${value}" (${source})`,
    );
  }
  return n;
}
