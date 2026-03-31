// ---------------------------------------------------------------------------
// Flow Engine -- Agent File Parser
//
// Parses agent `.md` files with YAML frontmatter and system prompt body.
// Uses manual parsing -- no external YAML library required.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { AgentConfig, AccessRules, CardConfig, ArchitectMeta } from "./types.js";

// ---- Public API -----------------------------------------------------------

/**
 * Parse an agent definition from a `.md` file on disk.
 */
export function parseAgentFile(filePath: string): AgentConfig {
  const content = readFileSync(filePath, "utf-8");
  return parseAgentString(content, filePath);
}

/**
 * Parse an agent definition from a string (useful for tests or inline defs).
 * `source` is recorded on the returned config for diagnostics.
 */
export function parseAgentString(content: string, source: string): AgentConfig {
  const { frontmatter, body } = splitFrontmatter(content, source);
  const fields = parseFrontmatterFields(frontmatter, source);

  const name = requireField(fields, "name", source);
  const description = requireField(fields, "description", source);
  const model = requireField(fields, "model", source);

  const thinking = fields.get("thinking") ?? undefined;
  const output = fields.get("output") ?? undefined;

  const interactive = fields.has("interactive")
    ? fields.get("interactive") === "true"
    : undefined;

  const tools = splitCsv(fields.get("tools") ?? "");
  const skills = splitCsv(fields.get("skills") ?? "") || undefined;
  const inputs = parseYamlArray(fields.get("inputs:array") ?? "") || undefined;
  const outputs = parseOutputsArray(fields, frontmatter) || undefined;

  const access = parseAccessBlock(fields, source);

  // Parse card: block (card.type, card.label, card.metric)
  const cardType = fields.get("card.type") ?? undefined;
  const cardLabel = fields.get("card.label")?.replace(/^["']|["']$/g, "") ?? undefined;
  const cardMetric = fields.get("card.metric") ?? undefined;
  const card: CardConfig | undefined = (cardType || cardLabel || cardMetric)
    ? {
        ...(cardType && { type: cardType }),
        ...(cardLabel && { label: cardLabel }),
        ...(cardMetric && { metric: cardMetric }),
      }
    : undefined;

  // Parse architect: block (architect.use_when, architect.produces, architect.depends_on, architect.domain)
  const archUseWhen = fields.get("architect.use_when")?.replace(/^["']|["']$/g, "") ?? undefined;
  const archProduces = fields.get("architect.produces")?.replace(/^["']|["']$/g, "") ?? undefined;
  const archDependsOn = fields.get("architect.depends_on")?.replace(/^["']|["']$/g, "") ?? undefined;
  const archDomain = fields.get("architect.domain") ?? undefined;
  const architect: ArchitectMeta | undefined = (archUseWhen || archProduces || archDependsOn || archDomain)
    ? {
        ...(archUseWhen && { use_when: archUseWhen }),
        ...(archProduces && { produces: archProduces }),
        ...(archDependsOn && { depends_on: archDependsOn }),
        ...(archDomain && { domain: archDomain }),
      }
    : undefined;

  return {
    name,
    description,
    model,
    ...(thinking !== undefined && { thinking }),
    tools,
    ...(skills !== undefined && skills.length > 0 && { skills }),
    ...(inputs !== undefined && inputs.length > 0 && { inputs }),
    ...(outputs !== undefined && outputs.length > 0 && { outputs }),
    systemPrompt: body.trim(),
    ...(output !== undefined && { output }),
    ...(interactive !== undefined && { interactive }),
    source,
    ...(access !== undefined && { access }),
    ...(card !== undefined && { card }),
    ...(architect !== undefined && { architect }),
  };
}

// ---- Internal helpers -----------------------------------------------------

/**
 * Split content into YAML frontmatter and markdown body.
 * Frontmatter is delimited by `---` on its own line at the start and a
 * closing `---`.
 */
function splitFrontmatter(
  content: string,
  source: string,
): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new Error(
      `Agent file has no YAML frontmatter (missing opening ---): ${source}`,
    );
  }

  // Find the closing ---. We skip the first line (the opening ---).
  const afterOpening = trimmed.indexOf("\n");
  if (afterOpening === -1) {
    throw new Error(`Agent file has only an opening --- line: ${source}`);
  }

  const rest = trimmed.slice(afterOpening + 1);
  const closingIdx = findClosingFence(rest);
  if (closingIdx === -1) {
    throw new Error(
      `Agent file has no closing --- for frontmatter: ${source}`,
    );
  }

  const frontmatter = rest.slice(0, closingIdx);
  const body = rest.slice(closingIdx + 3).replace(/^\r?\n/, ""); // skip the --- line and first newline

  return { frontmatter, body };
}

/**
 * Find the index of a `---` line that sits at the start of a line.
 */
function findClosingFence(text: string): number {
  // Check if text starts with ---
  if (/^---\s*$/.test(text.split("\n")[0])) {
    return 0;
  }

  // Look for \n--- on its own line
  const pattern = /\n---\s*$/m;
  const match = pattern.exec(text);
  if (match) {
    return match.index + 1; // +1 to skip the \n
  }
  return -1;
}

/**
 * Parse frontmatter lines into a flat map.  Handles:
 * - Simple `key: value`
 * - YAML arrays stored as `key:array` with joined values
 * - Nested blocks (access:) stored with dotted keys
 */
function parseFrontmatterFields(
  frontmatter: string,
  source: string,
): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = frontmatter.split("\n");

  let currentKey = "";
  let currentIndentLevel = 0; // depth of the current block context
  let blockStack: string[] = []; // stack of nested block key prefixes

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip blank lines
    if (line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;
    const trimmedLine = line.trim();

    // Detect YAML array items (lines like "  - value")
    if (/^- /.test(trimmedLine) && currentKey) {
      const value = trimmedLine.slice(2).trim().replace(/^["']|["']$/g, "");
      const arrayKey = `${currentKey}:array`;
      const existing = fields.get(arrayKey);
      fields.set(arrayKey, existing ? `${existing}\n${value}` : value);
      continue;
    }

    // If we're inside a block and this line is indented deeper than the
    // block parent, it's a nested key-value.
    if (blockStack.length > 0 && indent > currentIndentLevel) {
      const colonIdx = trimmedLine.indexOf(":");
      if (colonIdx !== -1) {
        const nestedKey = trimmedLine.slice(0, colonIdx).trim();
        const nestedValue = trimmedLine.slice(colonIdx + 1).trim();

        if (nestedValue === "") {
          // Deeper nesting (e.g., `bash:` inside `access:`)
          blockStack.push(nestedKey);
        } else {
          // Check if this is an array item line inside nested block
          const prefix = [...blockStack, nestedKey].join(".");
          // Strip surrounding quotes from YAML values
          const cleanNested = (nestedValue.startsWith('"') && nestedValue.endsWith('"')) || (nestedValue.startsWith("'") && nestedValue.endsWith("'"))
            ? nestedValue.slice(1, -1)
            : nestedValue;
          fields.set(prefix, cleanNested);
        }
      } else if (/^- /.test(trimmedLine)) {
        // Array item within nested block
        const value = trimmedLine.slice(2).trim().replace(/^["']|["']$/g, "");
        const arrayKey = blockStack.join(".") + ":array";
        const existing = fields.get(arrayKey);
        fields.set(arrayKey, existing ? `${existing}\n${value}` : value);
      }
      continue;
    }

    // We're back at root level (or starting fresh) -- pop block stack
    if (indent <= currentIndentLevel) {
      blockStack = [];
      currentIndentLevel = 0;
    }

    // Parse a root-level key: value
    const colonIdx = trimmedLine.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmedLine.slice(0, colonIdx).trim();
    const value = trimmedLine.slice(colonIdx + 1).trim();

    if (value === "") {
      // Start of a block (like `access:` or `context:` or `architect:`)
      currentKey = key;
      currentIndentLevel = indent;
      blockStack = [key];
    } else {
      currentKey = key;
      // Strip surrounding quotes from YAML values
      const cleanValue = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
      fields.set(key, cleanValue);
    }
  }

  return fields;
}

/**
 * Extract AccessRules from parsed fields.
 */
function parseAccessBlock(
  fields: Map<string, string>,
  _source: string,
): AccessRules | undefined {
  const readPatterns = parseYamlArray(fields.get("access.read:array") ?? "");
  const writePatterns = parseYamlArray(fields.get("access.write:array") ?? "");
  const bashDeny = parseYamlArray(fields.get("access.bash.deny:array") ?? "");

  if (readPatterns.length === 0 && writePatterns.length === 0 && bashDeny.length === 0) {
    return undefined;
  }

  const access: AccessRules = {};
  if (readPatterns.length > 0) access.read = readPatterns;
  if (writePatterns.length > 0) access.write = writePatterns;
  if (bashDeny.length > 0) access.bash = { deny: bashDeny };

  return access;
}

// ---- Utility functions ----------------------------------------------------

/** Split a comma-separated value string into trimmed, non-empty tokens. */
function splitCsv(value: string): string[] {
  if (!value.trim()) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse outputs from frontmatter. Supports:
 * - Simple array: `outputs: [findings, verdict]` or `outputs:\n  - findings\n  - verdict`
 * - Expanded objects: `outputs:\n  - name: findings\n    description: ...\n  - name: verdict`
 */
function parseOutputsArray(
  fields: Map<string, string>,
  frontmatter: string,
): Array<{name: string, description?: string}> | null {
  // First try simple array format (like inputs)
  const simpleArray = parseYamlArray(fields.get("outputs:array") ?? "");
  if (simpleArray.length > 0) {
    // Check if items look like "name: value" (expanded format parsed as flat array)
    // or plain names (simple format)
    const hasNamePrefix = simpleArray.some(item => item.startsWith("name:"));
    if (!hasNamePrefix) {
      // Simple format: each item is just a name
      return simpleArray.map(name => ({ name }));
    }
  }

  // Try expanded format: parse from raw frontmatter
  // Look for outputs: block and parse name/description pairs
  const outputEntries: Array<{name: string, description?: string}> = [];
  const lines = frontmatter.split("\n");
  let inOutputs = false;
  let currentEntry: {name?: string, description?: string} | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Detect start of outputs block
    if (/^outputs\s*:/.test(trimmed) && trimmed.endsWith(":")) {
      inOutputs = true;
      continue;
    }

    if (!inOutputs) continue;

    // Back to root level — end of outputs block
    if (indent === 0 && trimmed !== "" && !trimmed.startsWith("-")) {
      break;
    }

    // New array item
    if (/^- /.test(trimmed)) {
      // Save previous entry
      if (currentEntry?.name) {
        outputEntries.push({ name: currentEntry.name, ...(currentEntry.description && { description: currentEntry.description }) });
      }

      const afterDash = trimmed.slice(2).trim();
      // Check if it's `- name: value` on same line
      if (afterDash.startsWith("name:")) {
        const nameVal = afterDash.slice(5).trim().replace(/^["']|["']$/g, "");
        currentEntry = { name: nameVal };
      } else if (afterDash && !afterDash.includes(":")) {
        // Simple name: `- findings`
        currentEntry = { name: afterDash.replace(/^["']|["']$/g, "") };
      } else {
        currentEntry = {};
      }
      continue;
    }

    // Nested property of current entry
    if (currentEntry && indent > 2) {
      if (trimmed.startsWith("name:")) {
        currentEntry.name = trimmed.slice(5).trim().replace(/^["']|["']$/g, "");
      } else if (trimmed.startsWith("description:")) {
        currentEntry.description = trimmed.slice(12).trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  // Don't forget the last entry
  if (currentEntry?.name) {
    outputEntries.push({ name: currentEntry.name, ...(currentEntry.description && { description: currentEntry.description }) });
  }

  return outputEntries.length > 0 ? outputEntries : null;
}

/** Parse newline-separated array values (stored from YAML array lines). */
function parseYamlArray(joined: string): string[] {
  if (!joined.trim()) return [];
  return joined.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Require a field to be present, or throw. */
function requireField(
  fields: Map<string, string>,
  key: string,
  source: string,
): string {
  const value = fields.get(key);
  if (!value) {
    throw new Error(`Agent file missing required field "${key}": ${source}`);
  }
  return value;
}
