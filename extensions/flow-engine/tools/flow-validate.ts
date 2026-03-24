// ---------------------------------------------------------------------------
// Flow Validate Tool
//
// Validates flow .md content without writing to disk. Returns LSP-style
// diagnostics: { line, severity, message, suggestion? }
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, FlowStep, AgentStep, ForkStep, ConditionalStep, AgentDecisionStep } from "../types.js";

// ---- Diagnostic type ------------------------------------------------------

export interface Diagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
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

  // ---- 1. Frontmatter validation ------------------------------------------

  const trimmed = content.trimStart();
  const skippedLines = content.length - trimmed.length > 0
    ? content.slice(0, content.length - trimmed.length).split("\n").length - 1
    : 0;

  if (!trimmed.startsWith("---")) {
    diagnostics.push({
      line: 1,
      severity: "error",
      message: "Missing frontmatter. Flow files must start with ---",
      suggestion: "Add YAML frontmatter block at the top: ---\\nname: my-flow\\ndescription: ...\\n---",
    });
    return { valid: false, diagnostics };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    diagnostics.push({
      line: 1 + skippedLines,
      severity: "error",
      message: "Unclosed frontmatter (missing closing ---)",
    });
    return { valid: false, diagnostics };
  }

  const frontmatterStr = trimmed.slice(3, endIndex).trim();
  const frontmatterStartLine = 1 + skippedLines;

  // Parse frontmatter key-value pairs
  const frontmatter: Record<string, string> = {};
  const fmLines = frontmatterStr.split("\n");
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (match) {
      frontmatter[match[1]] = match[2].trim();
    }
  }

  // Required frontmatter fields
  if (!frontmatter.name) {
    diagnostics.push({
      line: frontmatterStartLine + 1,
      severity: "error",
      message: 'Missing required frontmatter field "name"',
      suggestion: "Add name: my-flow-name to the frontmatter block",
    });
  }
  if (!frontmatter.description) {
    diagnostics.push({
      line: frontmatterStartLine + 1,
      severity: "error",
      message: 'Missing required frontmatter field "description"',
      suggestion: "Add description: A brief description to the frontmatter block",
    });
  }

  // ---- 2. Step header validation ------------------------------------------

  const stepHeaders: { header: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+)$/);
    if (match) {
      stepHeaders.push({ header: match[1].trim(), line: i + 1 });
    }
  }

  const validPrefixes = ["fork:", "conditional:", "agent-decision:", "agent-loop-decision:", "flow-ref:"];
  const stepIds = new Set<string>();

  for (const { header, line } of stepHeaders) {
    const isSpecialStep = validPrefixes.some((p) => header.startsWith(p));
    if (isSpecialStep) {
      // Extract step ID from prefix
      const colonIdx = header.indexOf(":");
      const id = header.slice(colonIdx + 1).trim();
      if (!id) {
        diagnostics.push({
          line,
          severity: "error",
          message: `Step header "${header}" has empty ID after prefix`,
          suggestion: "Add an identifier after the colon, e.g., fork: choose-path",
        });
      } else {
        stepIds.add(id);
      }
    } else {
      // Agent step -- header is the step ID (agent name)
      if (!/^[\w][\w-]*$/.test(header)) {
        diagnostics.push({
          line,
          severity: "warning",
          message: `Step header "${header}" contains unusual characters for an agent name`,
          suggestion: "Agent step names should use alphanumeric characters and hyphens",
        });
      }
      stepIds.add(header);
    }
  }

  // ---- 3. Agent reference validation --------------------------------------

  if (getDiscoveredAgents) {
    const knownAgents = getDiscoveredAgents();
    for (const { header, line } of stepHeaders) {
      // Check agent steps
      if (!validPrefixes.some((p) => header.startsWith(p))) {
        if (!knownAgents.has(header)) {
          diagnostics.push({
            line,
            severity: "error",
            message: `Agent "${header}" is not in the discovered agent catalog`,
            suggestion: "Create the agent definition with agent_write or check the name spelling",
          });
        }
      }
      // Check agent-decision and agent-loop-decision agent refs
      if (header.startsWith("agent-decision:") || header.startsWith("agent-loop-decision:")) {
        const blockStart = lines.findIndex((l, idx) => idx >= line - 1 && l.match(/^##\s/));
        if (blockStart >= 0) {
          for (let j = blockStart + 1; j < lines.length; j++) {
            if (lines[j].match(/^##\s/)) break;
            const agentMatch = lines[j].match(/^agent:\s*(.+)$/);
            if (agentMatch) {
              const agentName = agentMatch[1].trim();
              if (!knownAgents.has(agentName)) {
                diagnostics.push({
                  line: j + 1,
                  severity: "warning",
                  message: `Agent "${agentName}" referenced in agent-decision is not in the catalog`,
                });
              }
            }
          }
        }
      }
    }
  }

  // ---- 4. Parse step bodies for blockedBy, inputs, branches ---------------

  const stepBlocks = parseStepBodies(lines);

  // ---- 5. blockedBy reference validation ----------------------------------

  for (const block of stepBlocks) {
    if (block.blockedBy) {
      for (const ref of block.blockedBy) {
        if (!stepIds.has(ref)) {
          diagnostics.push({
            line: block.blockedByLine ?? block.line,
            severity: "error",
            message: `blockedBy references unknown step ID "${ref}"`,
            suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
          });
        }
      }
    }
  }

  // ---- 6. DAG cycle detection ---------------------------------------------

  const adjacency = new Map<string, string[]>();
  for (const block of stepBlocks) {
    if (block.blockedBy) {
      adjacency.set(block.id, block.blockedBy);
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

  // ---- 7. Input wiring validation (result.X references) -------------------

  for (const block of stepBlocks) {
    if (block.inputRefs) {
      for (const { ref, line: refLine } of block.inputRefs) {
        if (!stepIds.has(ref)) {
          diagnostics.push({
            line: refLine,
            severity: "error",
            message: `Input reference {result.${ref}} points to unknown step ID "${ref}"`,
            suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
          });
        }
      }
    }
  }

  // ---- 8. Unknown template variables --------------------------------------

  const knownPrefixes = ["result", "input", "fork", "task", "loop"];
  for (let i = 0; i < lines.length; i++) {
    const templateMatches = lines[i].matchAll(/\{([\w.]+)\}/g);
    for (const m of templateMatches) {
      const varPath = m[1];
      const root = varPath.split(".")[0];
      if (!knownPrefixes.includes(root)) {
        diagnostics.push({
          line: i + 1,
          severity: "warning",
          message: `Unknown template variable "{${varPath}}"`,
          suggestion: `Known prefixes: ${knownPrefixes.join(", ")}`,
        });
      }
    }
  }

  // ---- 8b. Angle-bracket template syntax detection -------------------------

  for (let i = 0; i < lines.length; i++) {
    const angleBracketMatches = lines[i].matchAll(/<([\w][\w-]*)\.(summary|artifacts|status|files|fullOutput)>/g);
    for (const m of angleBracketMatches) {
      diagnostics.push({
        line: i + 1,
        severity: "error",
        message: `Angle-bracket syntax "<${m[0]}>" is not supported for template references`,
        suggestion: `Use {result.${m[1]}.${m[2]}} instead`,
      });
    }
  }

  // ---- 9. Fork branch target validation -----------------------------------

  for (const block of stepBlocks) {
    if (block.branches) {
      for (const [option, target] of Object.entries(block.branches)) {
        if (!stepIds.has(target)) {
          diagnostics.push({
            line: block.branchesLine ?? block.line,
            severity: "error",
            message: `Fork branch "${option}" targets unknown step ID "${target}"`,
            suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
          });
        }
      }
    }
  }

  // ---- 10. Agent-loop-decision validation ----------------------------------

  // Build ordered step ID list for forward/backward detection
  const orderedStepIds = stepHeaders.map(h => {
    const isSpecial = validPrefixes.some(p => h.header.startsWith(p));
    return isSpecial ? h.header.slice(h.header.indexOf(":") + 1).trim() : h.header;
  });

  for (const block of stepBlocks) {
    if (block.headerPrefix !== "agent-loop-decision") continue;

    // Validate loop_target
    if (block.loopTarget) {
      if (!stepIds.has(block.loopTarget)) {
        diagnostics.push({
          line: block.loopTargetLine ?? block.line,
          severity: "error",
          message: `loop_target "${block.loopTarget}" references unknown step ID`,
          suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
        });
      } else {
        // Warn if loop_target points forward (not a real backward loop)
        const blockIdx = orderedStepIds.indexOf(block.id);
        const targetIdx = orderedStepIds.indexOf(block.loopTarget);
        if (targetIdx >= 0 && blockIdx >= 0 && targetIdx > blockIdx) {
          diagnostics.push({
            line: block.loopTargetLine ?? block.line,
            severity: "warning",
            message: `loop_target "${block.loopTarget}" points forward — expected a backward jump for a loop`,
            suggestion: "loop_target should reference a step defined before this loop decision step",
          });
        }
      }
    } else {
      diagnostics.push({
        line: block.line,
        severity: "error",
        message: `agent-loop-decision "${block.id}" missing required "loop_target"`,
      });
    }

    // Validate exit_target
    if (block.exitTarget) {
      if (!stepIds.has(block.exitTarget)) {
        diagnostics.push({
          line: block.exitTargetLine ?? block.line,
          severity: "error",
          message: `exit_target "${block.exitTarget}" references unknown step ID`,
          suggestion: `Available step IDs: ${[...stepIds].join(", ")}`,
        });
      }
    } else {
      diagnostics.push({
        line: block.line,
        severity: "error",
        message: `agent-loop-decision "${block.id}" missing required "exit_target"`,
      });
    }

    // Validate max_iterations
    if (block.maxIterations) {
      const n = parseInt(block.maxIterations, 10);
      if (isNaN(n) || n <= 0) {
        diagnostics.push({
          line: block.maxIterationsLine ?? block.line,
          severity: "error",
          message: `max_iterations must be a positive integer, got "${block.maxIterations}"`,
        });
      }
    } else {
      diagnostics.push({
        line: block.line,
        severity: "error",
        message: `agent-loop-decision "${block.id}" missing required "max_iterations"`,
      });
    }
  }

  // ---- 11. Agent input coverage validation ---------------------------------

  if (getDiscoveredAgents) {
    const knownAgents = getDiscoveredAgents();
    for (const block of stepBlocks) {
      // Only check agent steps (not fork/conditional/etc)
      if (!validPrefixes.some((p) => block.id.startsWith(p.replace(":", "")))) {
        const agent = knownAgents.get(block.id);
        if (agent?.inputs && agent.inputs.length > 0) {
          const wiredKeys = new Set(block.inputKeys ?? []);
          // Warn on missing inputs
          for (const declared of agent.inputs) {
            if (!wiredKeys.has(declared)) {
              diagnostics.push({
                line: block.inputsLine ?? block.line,
                severity: "warning",
                message: `Agent "${block.id}" declares input "${declared}" but flow step does not wire it`,
                suggestion: `Add to inputs: block: ${declared}: {result.STEP_ID.summary}`,
              });
            }
          }
          // Warn on extra inputs
          const declaredSet = new Set(agent.inputs);
          for (const key of block.inputKeys ?? []) {
            if (!declaredSet.has(key)) {
              diagnostics.push({
                line: block.inputsLine ?? block.line,
                severity: "warning",
                message: `Flow step provides input "${key}" but agent "${block.id}" does not declare it`,
                suggestion: `Declared inputs: ${agent.inputs.join(", ")}`,
              });
            }
          }
        } else if (block.inputKeys && block.inputKeys.length > 0 && agent && (!agent.inputs || agent.inputs.length === 0)) {
          // Agent has no declared inputs but flow provides some
          for (const key of block.inputKeys) {
            diagnostics.push({
              line: block.inputsLine ?? block.line,
              severity: "warning",
              message: `Flow step provides input "${key}" but agent "${block.id}" does not declare any inputs`,
            });
          }
        }
      }
    }
  }

  // ---- Result -------------------------------------------------------------

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  return { valid: !hasErrors, diagnostics };
}

// ---- Step body parsing helper ---------------------------------------------

interface ParsedStepBlock {
  id: string;
  line: number;
  headerPrefix?: string;
  blockedBy?: string[];
  blockedByLine?: number;
  inputRefs?: { ref: string; line: number }[];
  inputKeys?: string[];
  inputsLine?: number;
  branches?: Record<string, string>;
  branchesLine?: number;
  loopTarget?: string;
  loopTargetLine?: number;
  exitTarget?: string;
  exitTargetLine?: number;
  maxIterations?: string;
  maxIterationsLine?: number;
}

function parseStepBodies(lines: string[]): ParsedStepBlock[] {
  const blocks: ParsedStepBlock[] = [];
  let currentId: string | null = null;
  let currentLine = 0;
  let currentBlock: ParsedStepBlock | null = null;

  const validPrefixes = ["fork:", "conditional:", "agent-decision:", "agent-loop-decision:", "flow-ref:"];

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^##\s+(.+)$/);
    if (headerMatch) {
      // Flush previous block
      if (currentBlock) blocks.push(currentBlock);

      const header = headerMatch[1].trim();
      const isSpecial = validPrefixes.some((p) => header.startsWith(p));
      if (isSpecial) {
        const colonIdx = header.indexOf(":");
        currentId = header.slice(colonIdx + 1).trim();
      } else {
        currentId = header;
      }
      currentLine = i + 1;
      currentBlock = { id: currentId, line: currentLine, headerPrefix: isSpecial ? header.slice(0, header.indexOf(":")) : undefined };
      continue;
    }

    if (!currentBlock) continue;

    // Parse blockedBy
    const blockedByMatch = lines[i].match(/^blockedBy:\s*(.+)$/);
    if (blockedByMatch) {
      currentBlock.blockedBy = blockedByMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
      currentBlock.blockedByLine = i + 1;
    }

    // Parse result.X template references
    const resultRefs = lines[i].matchAll(/\{result\.(\w[\w-]*)\}/g);
    for (const m of resultRefs) {
      if (!currentBlock.inputRefs) currentBlock.inputRefs = [];
      currentBlock.inputRefs.push({ ref: m[1], line: i + 1 });
    }

    // Parse inputs: (nested block)
    if (lines[i].match(/^inputs:$/)) {
      currentBlock.inputsLine = i + 1;
      currentBlock.inputKeys = [];
      for (let j = i + 1; j < lines.length; j++) {
        const inputMatch = lines[j].match(/^\s{2,}(\S[\w-]*):\s*(.+)$/);
        if (inputMatch) {
          currentBlock.inputKeys.push(inputMatch[1]);
        } else if (!lines[j].match(/^\s/) || lines[j].trim() === "") {
          break;
        }
      }
    }

    // Parse loop_target, exit_target, max_iterations for agent-loop-decision
    const loopTargetMatch = lines[i].match(/^loop_target:\s*(.+)$/);
    if (loopTargetMatch) {
      currentBlock.loopTarget = loopTargetMatch[1].trim();
      currentBlock.loopTargetLine = i + 1;
    }
    const exitTargetMatch = lines[i].match(/^exit_target:\s*(.+)$/);
    if (exitTargetMatch) {
      currentBlock.exitTarget = exitTargetMatch[1].trim();
      currentBlock.exitTargetLine = i + 1;
    }
    const maxIterationsMatch = lines[i].match(/^max_iterations:\s*(.+)$/);
    if (maxIterationsMatch) {
      currentBlock.maxIterations = maxIterationsMatch[1].trim();
      currentBlock.maxIterationsLine = i + 1;
    }

    // Parse branches (nested block)
    if (lines[i].match(/^branches:$/)) {
      currentBlock.branchesLine = i + 1;
      currentBlock.branches = {};
      // Read indented lines
      for (let j = i + 1; j < lines.length; j++) {
        const branchMatch = lines[j].match(/^\s{2,}(\S[\w-]*):\s*(.+)$/);
        if (branchMatch) {
          currentBlock.branches[branchMatch[1]] = branchMatch[2].trim();
        } else if (!lines[j].match(/^\s/) || lines[j].trim() === "") {
          break;
        }
      }
    }
  }

  // Flush last block
  if (currentBlock) blocks.push(currentBlock);

  return blocks;
}

// ---- Cycle detection (Kahn's algorithm) -----------------------------------

function detectCycle(adjacency: Map<string, string[]>): string[] | null {
  // Build in-degree map and full node set
  const nodes = new Set<string>();
  const inDeg = new Map<string, number>();
  const outEdges = new Map<string, string[]>();

  for (const [node, deps] of adjacency) {
    nodes.add(node);
    for (const dep of deps) {
      nodes.add(dep);
      // Edge: dep -> node (node is blocked by dep)
      if (!outEdges.has(dep)) outEdges.set(dep, []);
      outEdges.get(dep)!.push(node);
      inDeg.set(node, (inDeg.get(node) ?? 0) + 1);
    }
  }

  // Initialize in-degree for nodes with no dependencies
  for (const node of nodes) {
    if (!inDeg.has(node)) inDeg.set(node, 0);
  }

  // Kahn's algorithm
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

  // If not all nodes visited, there's a cycle
  if (visited.size < nodes.size) {
    // Find a cycle path for the diagnostic
    const remaining = [...nodes].filter((n) => !visited.has(n));
    return [...remaining, remaining[0]];
  }

  return null;
}

// ---- Tool registration ----------------------------------------------------

export function registerFlowValidateTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
): void {
  pi.registerTool({
    name: "flow_validate",
    description:
      "Validate flow .md content without writing to disk. Returns LSP-style diagnostics with line numbers, severity, messages, and suggestions.",
    parameters: Type.Object({
      content: Type.String({ description: "The flow .md content to validate" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const result = validateFlowContent(params.content, getDiscoveredAgents);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });
}
