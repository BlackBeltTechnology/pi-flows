// ---------------------------------------------------------------------------
// Flow Validation
//
// Validates flow YAML content and returns LSP-style diagnostics:
// { line, severity, message, suggestion? }
//
// Uses parseFlowYamlString() as the parser. A lightweight line index provides
// line-number attribution for diagnostics without duplicating parsing logic.
//
// Used internally by flow-write.ts. Not registered as a standalone tool.
// ---------------------------------------------------------------------------

import type {
  AgentConfig,
  Diagnostic,
  FlowConfig,
  FlowStep,
  AgentStep,
  CodeStep,
  ForkStep,
  ConditionalStep,
  AgentDecisionStep,
  AgentLoopDecisionStep,
  FlowRefStep,
} from "../types.js";
export type { Diagnostic };
import { parseFlowYamlString } from "../flow-parser-yaml.js";

// ---- Line index -----------------------------------------------------------

/** Line locations for a single step's header and properties. */
interface StepLineInfo {
  headerLine: number;
  props: Record<string, number>; // property name → line number
}

/** Line locations for frontmatter fields. */
interface FrontmatterLineInfo {
  openLine: number;   // line of opening ---
  closeLine: number;  // line of closing ---
  fields: Record<string, number>; // field name → line number
}

/** Complete line index for a flow file. */
interface LineIndex {
  frontmatter: FrontmatterLineInfo | null;
  steps: Map<string, StepLineInfo>; // step ID → line info
}

/**
 * Build a line index from YAML flow content. Scans lines once to map step IDs
 * and property names to their source line numbers. Used solely for diagnostic
 * attribution — no parsing of values.
 *
 * Handles YAML format: top-level keys as frontmatter, `- id: X` entries as
 * step boundaries, and indented properties within each step.
 */
function buildLineIndex(content: string): LineIndex {
  const lines = content.split("\n");
  const steps = new Map<string, StepLineInfo>();

  // YAML frontmatter: top-level keys before `steps:`
  const fmFields: Record<string, number> = {};
  let fmOpenLine = 1;
  let stepsLine = 0;

  // Step scanning state
  let currentStepId: string | null = null;
  let currentStepInfo: StepLineInfo | null = null;
  let inStepsArray = false;
  // Track nested block context for branches/inputs
  let nestedBlock: string | null = null; // "branches" | "inputs" | null

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Top-level key detection (no indentation)
    if (!inStepsArray) {
      const topLevelMatch = line.match(/^(\w[\w_]*):\s*/);
      if (topLevelMatch) {
        if (topLevelMatch[1] === "steps") {
          stepsLine = lineNum;
          inStepsArray = true;
        } else {
          fmFields[topLevelMatch[1]] = lineNum;
        }
        continue;
      }
    }

    if (!inStepsArray) continue;

    // Detect step boundary: `  - id: <value>` (sequence item with id)
    const stepIdMatch = trimmed.match(/^-\s+id:\s*(.+)$/);
    if (stepIdMatch) {
      // Flush previous step
      if (currentStepId && currentStepInfo) {
        steps.set(currentStepId, currentStepInfo);
      }
      currentStepId = stepIdMatch[1].trim();
      currentStepInfo = { headerLine: lineNum, props: {} };
      nestedBlock = null;
      continue;
    }

    // Property tracking within a step (indented key: value)
    if (currentStepInfo) {
      // Direct property (e.g., `    agent: foo`, `    task: >`)
      const propMatch = trimmed.match(/^(\w[\w_]*):\s*/);
      if (propMatch && !trimmed.startsWith("-")) {
        const propName = propMatch[1];
        currentStepInfo.props[propName] = lineNum;
        // Track if we're entering a nested block
        if (propName === "branches" || propName === "inputs") {
          nestedBlock = propName;
        } else {
          nestedBlock = null;
        }
        continue;
      }

      // Nested key under branches/inputs (e.g., `      "key": value`)
      if (nestedBlock) {
        const nestedMatch = trimmed.match(/^["']?([^"':]+)["']?\s*:\s*/);
        if (nestedMatch) {
          const nestedKey = nestedMatch[1].trim();
          if (nestedBlock === "inputs") {
            currentStepInfo.props[`input.${nestedKey}`] = lineNum;
          } else if (nestedBlock === "branches") {
            currentStepInfo.props[`branch.${nestedKey}`] = lineNum;
          }
        }
      }
    }
  }

  // Flush last step
  if (currentStepId && currentStepInfo) {
    steps.set(currentStepId, currentStepInfo);
  }

  const frontmatter: FrontmatterLineInfo = {
    openLine: fmOpenLine,
    closeLine: stepsLine > 0 ? stepsLine : fmOpenLine,
    fields: fmFields,
  };

  return { frontmatter, steps };
}

/** Get line number for a step's property, falling back to the step header line. */
function stepPropLine(idx: LineIndex, stepId: string, prop: string): number {
  const info = idx.steps.get(stepId);
  if (!info) return 1;
  return info.props[prop] ?? info.headerLine;
}

/** Get line number for a step header. */
function stepLine(idx: LineIndex, stepId: string): number {
  return idx.steps.get(stepId)?.headerLine ?? 1;
}

// ---- Public validation function -------------------------------------------

/**
 * Validate flow .md content and return diagnostics.
 * Accepts an optional agent lookup for cross-referencing agent names.
 */
export function validateFlowContent(
  content: string,
  getDiscoveredAgents?: () => Map<string, AgentConfig>,
): { valid: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const lines = content.split("\n");

  // ---- 0. Build line index ------------------------------------------------

  const idx = buildLineIndex(content);

  // ---- 1. Top-level field validation ---------------------------------------

  const frontmatterStartLine = idx.frontmatter?.openLine ?? 1;

  // Check required top-level fields
  if (!idx.frontmatter?.fields["name"]) {
    diagnostics.push({
      line: frontmatterStartLine,
      severity: "error",
      message: 'Missing required field "name"',
      suggestion: "Add name: my-flow-name at the top of the YAML file",
    });
  }
  if (!idx.frontmatter?.fields["description"]) {
    diagnostics.push({
      line: frontmatterStartLine,
      severity: "error",
      message: 'Missing required field "description"',
      suggestion: "Add description: A brief description at the top of the YAML file",
    });
  }

  // ---- 2. Step ID validation (pre-parse) -----------------------------------

  const stepIds = new Set<string>();

  for (const [id, info] of idx.steps) {
    if (!id) {
      diagnostics.push({
        line: info.headerLine,
        severity: "error",
        message: "Step has empty id field",
        suggestion: "Add an id value, e.g., id: my-step",
      });
    } else {
      stepIds.add(id);
    }
  }

  // ---- 3. Parse with canonical parser -------------------------------------

  let flow: FlowConfig;
  try {
    flow = parseFlowYamlString(content, "<validate>");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Try to attribute the error to a step by scanning the message for step names
    let errorLine = 1;
    for (const [id, info] of idx.steps) {
      if (message.includes(`"${id}"`)) {
        errorLine = info.headerLine;
        break;
      }
    }
    diagnostics.push({
      line: errorLine,
      severity: "error",
      message,
    });
    const hasErrors = diagnostics.some(d => d.severity === "error");
    return { valid: !hasErrors, diagnostics };
  }

  // ---- 4. Semantic validation on parsed FlowConfig ------------------------

  // Build ordered step ID list for forward/backward detection
  const orderedStepIds = flow.steps.map(s => s.id);

  // 4a. Agent reference validation
  if (getDiscoveredAgents) {
    const knownAgents = getDiscoveredAgents();

    for (const step of flow.steps) {
      switch (step.stepType) {
        case "agent": {
          const s = step as AgentStep;
          if (!knownAgents.has(s.agent)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, "agent"),
              severity: "error",
              message: `Agent "${s.agent}" is not in the discovered agent catalog`,
              suggestion: "Create the agent definition with agent_write or check the name spelling",
            });
          }
          break;
        }
        case "agent-decision": {
          const s = step as AgentDecisionStep;
          if (!knownAgents.has(s.agent)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, "agent"),
              severity: "warning",
              message: `Agent "${s.agent}" referenced in agent-decision is not in the catalog`,
            });
          }
          break;
        }
        case "agent-loop-decision": {
          const s = step as AgentLoopDecisionStep;
          if (!knownAgents.has(s.agent)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, "agent"),
              severity: "warning",
              message: `Agent "${s.agent}" referenced in agent-loop-decision is not in the catalog`,
            });
          }
          break;
        }
        case "fork": {
          const s = step as ForkStep;
          if (s.agent && !knownAgents.has(s.agent)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, "agent"),
              severity: "warning",
              message: `Fork "${s.id}" references agent "${s.agent}" which is not in the discovered catalog`,
              suggestion: "Ensure the agent exists or will be created before the flow runs",
            });
          }
          // allowCustom requires agent: field for custom answer routing
          if (s.allowCustom && !s.agent) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, "allowCustom"),
              severity: "error",
              message: `Fork "${s.id}" has allowCustom: true but no agent: field. An agent is required to route custom freetext answers to branches.`,
              suggestion: "Add agent: <agent-name> to this fork step",
            });
          }
          break;
        }
      }
    }
  }

  // 4b. Code node validation: id, inputs, outputs, references
  for (const step of flow.steps) {
    if (step.stepType !== "code") continue;
    const s = step as CodeStep;

    // Filesystem-safe id: no /, \, .., :
    if (!/^[a-zA-Z0-9_.-]+$/.test(s.id)) {
      diagnostics.push({
        line: stepPropLine(idx, s.id, "id") || stepLine(idx, s.id),
        severity: "error",
        message: `Code node id "${s.id}" must be filesystem-safe (alphanumeric, dash, underscore, dot only)`,
        suggestion: "Use only letters, numbers, dash, underscore, and dot in the id",
      });
    }

    // Input names must be valid JS identifiers
    if (s.inputs) {
      for (const key of Object.keys(s.inputs)) {
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, `input.${key}`) || stepPropLine(idx, s.id, "inputs"),
            severity: "error",
            message: `input name "${key}" is not a valid JavaScript identifier`,
            suggestion: "Input names must start with a letter, underscore, or dollar sign, followed by alphanumeric characters, underscores, or dollar signs",
          });
        }
      }
    }

    // Output names must be unique and valid JS identifiers
    const outputNames = new Set<string>();
    if (s.outputs) {
      for (const output of s.outputs) {
        const name = output.name;
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, `output.${name}`) || stepPropLine(idx, s.id, "outputs"),
            severity: "error",
            message: `output name "${name}" is not a valid JavaScript identifier`,
            suggestion: "Output names must start with a letter, underscore, or dollar sign, followed by alphanumeric characters, underscores, or dollar signs",
          });
        }
        if (outputNames.has(name)) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, `output.${name}`) || stepPropLine(idx, s.id, "outputs"),
            severity: "error",
            message: `output name "${name}" is duplicate (declared multiple times)`,
            suggestion: "Each output name must be unique",
          });
        }
        outputNames.add(name);
      }
    }

    // blockedBy references
    if (s.blockedBy) {
      for (const ref of s.blockedBy) {
        if (!stepIds.has(ref)) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, "blockedBy"),
            severity: "error",
            message: `blockedBy references unknown step ID "${ref}"`,
            suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
          });
        }
      }
    }

    // on_complete reference
    if (s.on_complete && !stepIds.has(s.on_complete)) {
      diagnostics.push({
        line: stepPropLine(idx, s.id, "on_complete"),
        severity: "error",
        message: `on_complete references unknown step ID "${s.on_complete}"`,
        suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
      });
    }

    // on_error reference
    if (s.on_error && !stepIds.has(s.on_error)) {
      diagnostics.push({
        line: stepPropLine(idx, s.id, "on_error"),
        severity: "error",
        message: `on_error references unknown step ID "${s.on_error}"`,
        suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
      });
    }
  }

  // 4c. Agent blockedBy reference validation
  for (const step of flow.steps) {
    if (step.stepType !== "agent") continue;
    const s = step as AgentStep;
    if (!s.blockedBy) continue;
    for (const ref of s.blockedBy) {
      if (!stepIds.has(ref)) {
        diagnostics.push({
          line: stepPropLine(idx, s.id, "blockedBy"),
          severity: "error",
          message: `blockedBy references unknown step ID "${ref}"`,
          suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
        });
      }
    }
  }

  // 4d. DAG cycle detection
  const adjacency = new Map<string, string[]>();
  for (const step of flow.steps) {
    if (step.stepType === "agent") {
      const s = step as AgentStep;
      if (s.blockedBy && s.blockedBy.length > 0) {
        adjacency.set(s.id, s.blockedBy);
      }
    }
  }

  const cycle = detectCycle(adjacency);
  if (cycle) {
    diagnostics.push({
      line: 1,
      severity: "error",
      message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
      suggestion: "Remove one of the blockedBy references to break the cycle",
    });
  }

  // 4d. Input wiring — result.X reference validation
  for (const step of flow.steps) {
    if (step.stepType !== "agent") continue;
    const s = step as AgentStep;
    if (!s.inputs) continue;
    for (const [key, val] of Object.entries(s.inputs)) {
      // Skip file:// inputs — they are file paths, not step references
      if (val.startsWith("file://")) continue;
      // Extract result.X references from the value
      const refs = val.matchAll(/(?:\$\{\{|\{)result\.(\w[\w-]*)(?:\}\}|\})/g);
      for (const m of refs) {
        if (!stepIds.has(m[1])) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, `input.${key}`) || stepPropLine(idx, s.id, "inputs"),
            severity: "error",
            message: `Input reference {result.${m[1]}} points to unknown step ID "${m[1]}"`,
            suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
          });
        }
      }
    }
  }

  // 4e. Output wiring validation — warn on ${{result.STEP.FIELD}} when FIELD is not a declared output
  const STANDARD_RESULT_FIELDS = new Set(["summary", "artifacts", "files", "status", "fullOutput"]);
  for (const step of flow.steps) {
    if (step.stepType !== "agent") continue;
    const s = step as AgentStep;

    // Collect all template strings that may contain result references
    const templateStrings: string[] = [];
    if (s.task) templateStrings.push(s.task);
    if (s.inputs) {
      for (const val of Object.values(s.inputs)) {
        // Skip file:// inputs — they are file paths, not template expressions
        if (!val.startsWith("file://")) templateStrings.push(val);
      }
    }

    for (const tpl of templateStrings) {
      // Match ${{result.STEP.FIELD}} patterns
      const refs = tpl.matchAll(/(?:\$\{\{|\{)result\.([\w-]+)\.([\w]+)(?:\}\}|\})/g);
      for (const m of refs) {
        const refStepId = m[1];
        const refField = m[2];

        // Skip standard fields — always valid
        if (STANDARD_RESULT_FIELDS.has(refField)) continue;

        // Find the referenced step's agent and check its declared outputs
        const refStep = flow.steps.find(st => st.id === refStepId);
        if (!refStep || refStep.stepType !== "agent") continue;

        const refAgent = getDiscoveredAgents?.()?.get((refStep as AgentStep).agent);
        if (!refAgent) continue;

        const declaredOutputNames = (refAgent.outputs ?? []).map(o => o.name);
        if (!declaredOutputNames.includes(refField)) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, "task") || stepPropLine(idx, s.id, "inputs"),
            severity: "warning",
            message: `result.${refStepId}.${refField} references field "${refField}" which is not a declared output of agent "${(refStep as AgentStep).agent}"`,
            suggestion: declaredOutputNames.length > 0
              ? `Declared outputs: ${declaredOutputNames.join(", ")}. Standard fields: summary, artifacts, files, status`
              : `Agent "${(refStep as AgentStep).agent}" has no declared outputs. Use .summary, .artifacts, .files, or .status`,
          });
        }
      }
    }
  }

  // 4f. Branch target validation (fork + agent-decision)
  for (const step of flow.steps) {
    if (step.stepType === "fork") {
      const s = step as ForkStep;
      if (s.branches) {
        for (const [option, target] of Object.entries(s.branches)) {
          if (!stepIds.has(target)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, `branch.${option}`) || stepPropLine(idx, s.id, "branches"),
              severity: "error",
              message: `Fork branch "${option}" targets unknown step ID "${target}"`,
              suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
            });
          }
        }
      }
    }
    if (step.stepType === "agent-decision") {
      const s = step as AgentDecisionStep;
      for (const [branch, target] of Object.entries(s.branches)) {
        if (!stepIds.has(target)) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, `branch.${branch}`) || stepPropLine(idx, s.id, "branches"),
            severity: "error",
            message: `Agent-decision branch "${branch}" targets unknown step ID "${target}"`,
            suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
          });
        }
      }
    }
  }

  // 4g. Agent-loop-decision target validation
  for (const step of flow.steps) {
    if (step.stepType !== "agent-loop-decision") continue;
    const s = step as AgentLoopDecisionStep;

    // loop_target
    if (!stepIds.has(s.loop_target)) {
      diagnostics.push({
        line: stepPropLine(idx, s.id, "loop_target"),
        severity: "error",
        message: `loop_target "${s.loop_target}" references unknown step ID`,
        suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
      });
    } else {
      // Warn if loop_target points forward
      const blockIdx = orderedStepIds.indexOf(s.id);
      const targetIdx = orderedStepIds.indexOf(s.loop_target);
      if (targetIdx >= 0 && blockIdx >= 0 && targetIdx > blockIdx) {
        diagnostics.push({
          line: stepPropLine(idx, s.id, "loop_target"),
          severity: "warning",
          message: `loop_target "${s.loop_target}" points forward — expected a backward jump for a loop`,
          suggestion: "loop_target should reference a step defined before this loop decision step",
        });
      }
    }

    // exit_target
    if (!stepIds.has(s.exit_target)) {
      diagnostics.push({
        line: stepPropLine(idx, s.id, "exit_target"),
        severity: "error",
        message: `exit_target "${s.exit_target}" references unknown step ID`,
        suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
      });
    }
  }

  // 4h. Agent input coverage validation
  if (getDiscoveredAgents) {
    const knownAgents = getDiscoveredAgents();
    for (const step of flow.steps) {
      if (step.stepType !== "agent") continue;
      const s = step as AgentStep;
      const agent = knownAgents.get(s.agent);
      if (!agent) continue;

      const wiredKeys = new Set(s.inputs ? Object.keys(s.inputs) : []);

      if (agent.inputs && agent.inputs.length > 0) {
        // Warn on missing inputs
        for (const declared of agent.inputs) {
          if (!wiredKeys.has(declared)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, "inputs") || stepLine(idx, s.id),
              severity: "warning",
              message: `Agent "${s.agent}" declares input "${declared}" but flow step does not wire it`,
              suggestion: `Add to inputs: block: ${declared}: \${{result.STEP_ID.summary}}`,
            });
          }
        }
        // Warn on extra inputs
        const declaredSet = new Set(agent.inputs);
        for (const key of wiredKeys) {
          if (!declaredSet.has(key)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, `input.${key}`) || stepPropLine(idx, s.id, "inputs"),
              severity: "warning",
              message: `Flow step provides input "${key}" but agent "${s.agent}" does not declare it`,
              suggestion: `Declared inputs: ${agent.inputs.join(", ")}`,
            });
          }
        }
      } else if (wiredKeys.size > 0) {
        // Agent has no declared inputs but flow provides some
        for (const key of wiredKeys) {
          diagnostics.push({
            line: stepPropLine(idx, s.id, `input.${key}`) || stepPropLine(idx, s.id, "inputs"),
            severity: "warning",
            message: `Flow step provides input "${key}" but agent "${s.agent}" does not declare any inputs`,
          });
        }
      }

      // 4g2. Cross-check: wired inputs must be referenced in agent body or step task
      if (agent.systemPrompt && wiredKeys.size > 0) {
        const stepTask = s.task ?? "";
        for (const key of wiredKeys) {
          const ref = `\${{input.${key}}}`;
          if (!agent.systemPrompt.includes(ref) && !stepTask.includes(ref)) {
            diagnostics.push({
              line: stepPropLine(idx, s.id, `input.${key}`) || stepPropLine(idx, s.id, "inputs"),
              severity: "warning",
              message: `Wired input "${key}" is not referenced as \${{input.${key}}} in agent body or step task — value will be silently lost`,
              suggestion: `Add \${{input.${key}}} to the agent's system prompt body or this step's task text`,
            });
          }
        }
      }
    }
  }

  // ---- 5. Raw-line scans (template variables, deprecated syntax) ----------

  const knownPrefixes = ["result", "input", "task", "loop"];

  // 5a. Primary syntax: ${{...}}
  for (let i = 0; i < lines.length; i++) {
    const templateMatches = lines[i].matchAll(/\$\{\{([\w.\-]+)\}\}/g);
    for (const m of templateMatches) {
      const varPath = m[1];
      const root = varPath.split(".")[0];
      if (root === "fork") {
        diagnostics.push({
          line: i + 1,
          severity: "warning",
          message: `Deprecated: \${{${varPath}}} — fork context is now autowired into branch steps`,
          suggestion: "Remove this reference. The branch step automatically receives fork question, answer, and notes in its system prompt.",
        });
      } else if (!knownPrefixes.includes(root)) {
        // Check if the unrecognized root matches a step ID — likely missing "result." prefix
        const suggestion = stepIds.has(root)
          ? `Did you mean \${{result.${varPath}}}?`
          : `Known prefixes: ${knownPrefixes.join(", ")}`;
        diagnostics.push({
          line: i + 1,
          severity: "error",
          message: `Template variable "\${{${varPath}}}" has unrecognized prefix "${root}" — will resolve to empty string at runtime`,
          suggestion,
        });
      } else {
        // Check for nested field access (4+ segments like result.step.artifacts.subfield)
        const segments = varPath.split(".");
        if (segments.length >= 4) {
          const stepId = segments[1];
          const deepPath = segments.slice(2).join(".");
          const leafField = segments[segments.length - 1];
          diagnostics.push({
            line: i + 1,
            severity: "error",
            message: `Nested field access "\${{${varPath}}}" is not supported — the template engine only resolves \${{result.STEP.FIELD}}`,
            suggestion: `Use typed outputs: declare "${leafField}" in the agent's outputs: field and reference as \${{result.${stepId}.${leafField}}}`,
          });
        }
      }
    }
  }

  // 5b. Deprecated single-brace syntax
  for (let i = 0; i < lines.length; i++) {
    const singleBraceMatches = lines[i].matchAll(/(?<!\$\{)\{([\w][\w.]*)\}(?!\})/g);
    for (const m of singleBraceMatches) {
      const varPath = m[1];
      const root = varPath.split(".")[0];
      if (knownPrefixes.includes(root)) {
        diagnostics.push({
          line: i + 1,
          severity: "warning",
          message: `Deprecated single-brace syntax "{${varPath}}" — use \${{${varPath}}} instead`,
          suggestion: `Replace {${varPath}} with \${{${varPath}}}`,
        });
      }
    }
  }

  // 5c. Angle-bracket template syntax detection
  for (let i = 0; i < lines.length; i++) {
    const angleBracketMatches = lines[i].matchAll(/<([\w][\w-]*)\.(summary|artifacts|status|files|fullOutput)>/g);
    for (const m of angleBracketMatches) {
      diagnostics.push({
        line: i + 1,
        severity: "error",
        message: `Angle-bracket syntax "<${m[0]}>" is not supported for template references`,
        suggestion: `Use \${{result.${m[1]}.${m[2]}}} instead`,
      });
    }
  }

  // 5d. (Reserved — former allowNotes/decisionAgent deprecation checks removed)

  // ---- Result -------------------------------------------------------------

  const hasErrors = diagnostics.some(d => d.severity === "error");
  return { valid: !hasErrors, diagnostics };
}

// ---- Cycle detection (Kahn's algorithm) -----------------------------------

function detectCycle(adjacency: Map<string, string[]>): string[] | null {
  const nodes = new Set<string>();
  const inDeg = new Map<string, number>();
  const outEdges = new Map<string, string[]>();

  for (const [node, deps] of adjacency) {
    nodes.add(node);
    for (const dep of deps) {
      nodes.add(dep);
      if (!outEdges.has(dep)) outEdges.set(dep, []);
      outEdges.get(dep)!.push(node);
      inDeg.set(node, (inDeg.get(node) ?? 0) + 1);
    }
  }

  for (const node of nodes) {
    if (!inDeg.has(node)) inDeg.set(node, 0);
  }

  const queue: string[] = [];
  for (const [node, deg] of inDeg) {
    if (deg === 0) queue.push(node);
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited.add(node);
    for (const neighbor of outEdges.get(node) ?? []) {
      const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited.size < nodes.size) {
    const remaining = [...nodes].filter(n => !visited.has(n));
    return [...remaining, remaining[0]];
  }

  return null;
}

