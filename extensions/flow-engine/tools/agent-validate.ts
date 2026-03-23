// ---------------------------------------------------------------------------
// Agent Validate Tool
//
// Validates agent .md content without writing to disk. Returns LSP-style
// diagnostics: { line, severity, message, suggestion? }
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---- Diagnostic type (same as flow-validate) ------------------------------

export interface Diagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
}

// ---- Known constants ------------------------------------------------------

const KNOWN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "bash",
  "model_cli",
  "model_cli_readonly",
  "subagent",
  "ask_user",
  "skill_read",
  "agent_catalog",
  "agent_validate",
  "agent_write",
  "flow_validate",
  "flow_write",
  "flow_preview",
]);

const KNOWN_MODEL_ROLES = new Set([
  "@planning",
  "@coding",
  "@modelling",
  "@compact",
  "@fast",
  "@vision",
]);

// ---- Public validation function -------------------------------------------

/**
 * Validate agent .md content and return diagnostics.
 */
export function validateAgentContent(
  content: string,
): { valid: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const lines = content.split("\n");

  // ---- 1. Frontmatter presence and parsing --------------------------------

  const trimmed = content.trimStart();
  const skippedLines = content.length - trimmed.length > 0
    ? content.slice(0, content.length - trimmed.length).split("\n").length - 1
    : 0;

  if (!trimmed.startsWith("---")) {
    diagnostics.push({
      line: 1,
      severity: "error",
      message: "Missing frontmatter. Agent files must start with ---",
      suggestion: "Add YAML frontmatter block: ---\\nname: my-agent\\ndescription: ...\\nmodel: @coding\\ntools: read, write\\n---",
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
  const bodyStr = trimmed.slice(endIndex + 4);

  // Parse frontmatter fields
  const fields = new Map<string, { value: string; line: number }>();
  const fmLines = frontmatterStr.split("\n");
  let currentBlock = "";
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Nested block value
    if (indent > 0 && currentBlock) {
      const colonIdx = trimmedLine.indexOf(":");
      if (colonIdx > 0) {
        const nestedKey = `${currentBlock}.${trimmedLine.slice(0, colonIdx).trim()}`;
        const nestedVal = trimmedLine.slice(colonIdx + 1).trim();
        fields.set(nestedKey, { value: nestedVal, line: frontmatterStartLine + 1 + i });
      }
      continue;
    }

    const match = trimmedLine.match(/^([\w][\w_]*):\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      if (value === "") {
        currentBlock = key;
      } else {
        currentBlock = "";
        fields.set(key, { value, line: frontmatterStartLine + 1 + i });
      }
    }
  }

  // ---- 2. Required fields -------------------------------------------------

  if (!fields.has("name")) {
    diagnostics.push({
      line: frontmatterStartLine + 1,
      severity: "error",
      message: 'Missing required frontmatter field "name"',
      suggestion: "Add name: my-agent-name",
    });
  }

  if (!fields.has("description")) {
    diagnostics.push({
      line: frontmatterStartLine + 1,
      severity: "error",
      message: 'Missing required frontmatter field "description"',
      suggestion: "Add description: What this agent does",
    });
  }

  if (!fields.has("tools")) {
    diagnostics.push({
      line: frontmatterStartLine + 1,
      severity: "error",
      message: 'Missing required frontmatter field "tools"',
      suggestion: "Add tools: read, write, edit, grep, bash",
    });
  }

  // ---- 3. Tool name validation --------------------------------------------

  if (fields.has("tools")) {
    const toolsEntry = fields.get("tools")!;
    const toolNames = toolsEntry.value.split(",").map((t) => t.trim()).filter(Boolean);
    for (const tool of toolNames) {
      if (!KNOWN_TOOLS.has(tool)) {
        diagnostics.push({
          line: toolsEntry.line,
          severity: "error",
          message: `Unknown tool "${tool}"`,
          suggestion: `Known tools: ${[...KNOWN_TOOLS].join(", ")}`,
        });
      }
    }
  }

  // ---- 4. Model role validation -------------------------------------------

  if (fields.has("model")) {
    const modelEntry = fields.get("model")!;
    const modelValue = modelEntry.value;
    if (modelValue.startsWith("@")) {
      // Role alias -- check against known roles
      const role = modelValue.split(":")[0]; // strip thinking suffix if present
      if (!KNOWN_MODEL_ROLES.has(role)) {
        diagnostics.push({
          line: modelEntry.line,
          severity: "error",
          message: `Unknown model role "${role}"`,
          suggestion: `Known roles: ${[...KNOWN_MODEL_ROLES].join(", ")}`,
        });
      }
    }
    // Explicit model IDs and model:thinking combos are allowed as-is
  }

  // ---- 5. Input identifier validation -------------------------------------

  if (fields.has("inputs")) {
    const inputsEntry = fields.get("inputs")!;
    const inputs = inputsEntry.value.split(",").map((s) => s.trim()).filter(Boolean);
    for (const input of inputs) {
      if (!/^[a-zA-Z0-9][\w-]*$/.test(input)) {
        diagnostics.push({
          line: inputsEntry.line,
          severity: "error",
          message: `Invalid input identifier "${input}"`,
          suggestion: "Input names must be alphanumeric with hyphens, starting with a letter or digit",
        });
      }
    }
  }

  // ---- 6. Access rule path pattern validation -----------------------------

  for (const [key, entry] of fields) {
    if (key === "access.read" || key === "access.write") {
      const patterns = entry.value.split(",").map((s) => s.trim()).filter(Boolean);
      for (const pattern of patterns) {
        // Basic syntax check: should start with a path-like character or glob
        if (!/^[./*\w~]/.test(pattern)) {
          diagnostics.push({
            line: entry.line,
            severity: "warning",
            message: `Access pattern "${pattern}" looks invalid`,
            suggestion: "Access patterns should be glob-like paths, e.g., src/**, *.ts, ./config/*",
          });
        }
      }
    }
  }

  // ---- 7. Card config validation ------------------------------------------

  const cardType = fields.get("card.type");
  if (cardType) {
    const validTypes = ["status", "metric", "progress", "log"];
    if (!validTypes.includes(cardType.value)) {
      diagnostics.push({
        line: cardType.line,
        severity: "warning",
        message: `Unknown card type "${cardType.value}"`,
        suggestion: `Known card types: ${validTypes.join(", ")}`,
      });
    }
  }

  const cardMetric = fields.get("card.metric");
  if (cardMetric && !cardType) {
    diagnostics.push({
      line: cardMetric.line,
      severity: "warning",
      message: "card.metric specified without card.type",
      suggestion: "Add card.type to define how the card should render",
    });
  }

  // ---- 8. task placeholder in body -----------------------------------------

  if (!bodyStr.includes("{task}")) {
    diagnostics.push({
      line: lines.length,
      severity: "warning",
      message: "Agent body does not contain {task} placeholder",
      suggestion: "Include {task} in the system prompt body so the task can be injected at runtime",
    });
  }

  // ---- Result -------------------------------------------------------------

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  return { valid: !hasErrors, diagnostics };
}

// ---- Tool registration ----------------------------------------------------

export function registerAgentValidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_validate",
    description:
      "Validate agent .md content without writing to disk. Returns LSP-style diagnostics with line numbers, severity, messages, and suggestions.",
    parameters: Type.Object({
      content: Type.String({ description: "The agent .md content to validate" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const result = validateAgentContent(params.content);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: {},
      };
    },
  });
}
