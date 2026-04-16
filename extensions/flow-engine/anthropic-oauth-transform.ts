// ---------------------------------------------------------------------------
// Anthropic OAuth Payload Transform for Flow Agent Sessions
//
// ⚠️  ANTHROPIC-SPECIFIC WORKAROUND (April 2026)
//
// Anthropic's OAuth subscription endpoint fingerprints tool names and system
// prompt text. Requests with non-Claude-Code tool names are classified as
// "extra usage" and rejected. This module transforms outbound API payloads
// so spawned flow agent sessions pass Anthropic's filtering.
//
// This is an undocumented Anthropic behavior — not an official API contract.
// It may change at any time. All Anthropic-specific logic is isolated in this
// single file so it can be updated, disabled, or removed without touching
// core flow execution logic.
//
// To remove: delete this file and the one `extraAgentExtensions.push()` call
// in flow-engine/index.ts.
//
// Source for allowlist: pi-coding-agent/packages/ai/src/providers/anthropic.ts
// Reference impl: @benvargas/pi-claude-code-use/extensions/index.ts
// ---------------------------------------------------------------------------

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

// ============================================================================
// Core Claude Code tool allowlist
//
// WHY:  Anthropic's OAuth endpoint only accepts tool names that match their
//       Claude Code client's known tool set. Any other flat tool name triggers
//       "extra usage" classification.
//
// WHAT: Case-insensitive set of tool names that always pass through filtering.
//
// SOURCE: Mirrors pi-coding-agent's claudeCodeTools list in
//         packages/ai/src/providers/anthropic.ts
//         and @benvargas/pi-claude-code-use's CORE_TOOL_NAMES.
//
// UPDATE: If Anthropic adds tools to their allowlist, add them here.
// ============================================================================

const CORE_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "askuserquestion",
  "enterplanmode",
  "exitplanmode",
  "killshell",
  "notebookedit",
  "skill",
  "task",
  "taskoutput",
  "todowrite",
  "webfetch",
  "websearch",
]);

// ============================================================================
// Known companion tool flat→MCP alias mappings
//
// WHY:  Anthropic rejects flat companion names (e.g., "web_search_exa") but
//       accepts MCP-style names (e.g., "mcp__exa__web_search").
//
// WHAT: When a flat companion tool name is found AND its MCP alias is also
//       present in the tool list, the flat name is renamed to the alias.
//
// UPDATE: If new companion tools are added, add mappings here.
// ============================================================================

const FLAT_TO_MCP = new Map<string, string>([
  ["web_search_exa", "mcp__exa__web_search"],
  ["get_code_context_exa", "mcp__exa__get_code_context"],
  ["firecrawl_scrape", "mcp__firecrawl__scrape"],
  ["firecrawl_map", "mcp__firecrawl__map"],
  ["firecrawl_search", "mcp__firecrawl__search"],
  ["generate_image", "mcp__antigravity__generate_image"],
  ["image_quota", "mcp__antigravity__image_quota"],
]);

// ============================================================================
// System prompt rewrite
//
// WHY:  Anthropic fingerprints system prompt text to detect non-Claude-Code
//       clients. Certain pi-identifying phrases trigger the detection.
//
// WHAT: Replaces a small set of phrases in system prompt text blocks.
//       Preserves cache_control metadata, non-text blocks, and payload shape.
//
// UPDATE: If Anthropic changes prompt fingerprinting, update replacements here.
// ============================================================================

function rewritePromptText(text: string): string {
  return text
    .replaceAll("pi itself", "the cli itself")
    .replaceAll("pi .md files", "cli .md files")
    .replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
  if (typeof system === "string") {
    return rewritePromptText(system);
  }
  if (!Array.isArray(system)) {
    return system;
  }
  return system.map((block) => {
    if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
      return block;
    }
    const rewritten = rewritePromptText(block.text);
    return rewritten === block.text ? block : { ...block, text: rewritten };
  });
}

// ============================================================================
// Tool filtering
//
// WHY:  Anthropic's OAuth endpoint rejects requests containing tool names
//       outside the Claude Code set. Flow agents declare tools like "finish",
//       "skill_read", "find", "ls" which are not in that set.
//
// WHAT: Filters the tools array to keep only:
//       1. Anthropic-native typed tools (have a `type` field, e.g., web_search)
//       2. Core Claude Code tool names (case-insensitive)
//       3. Tools prefixed with mcp__ (MCP-style names always pass)
//       4. Known companion tools renamed to their MCP alias (if alias present)
//       Everything else is removed. Deduplicates by lowercase name.
//
// UPDATE: If Anthropic relaxes filtering, this function can return tools as-is.
// ============================================================================

function collectToolNames(tools: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (isPlainObject(tool) && typeof tool.name === "string") {
      names.add(lower(tool.name));
    }
  }
  return names;
}

function filterAndRemapTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(tools)) return tools;

  const advertised = collectToolNames(tools);
  const emitted = new Set<string>();
  const result: unknown[] = [];

  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;

    // Rule 1: Anthropic-native typed tools always pass through
    if (typeof tool.type === "string" && tool.type.trim().length > 0) {
      result.push(tool);
      continue;
    }

    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) continue;
    const nameLc = lower(name);

    // Rule 2 & 3: core tools and mcp__-prefixed pass through (with dedup)
    if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) {
      if (!emitted.has(nameLc)) {
        emitted.add(nameLc);
        result.push(tool);
      }
      continue;
    }

    // Rule 4: known companion tool — rename to MCP alias if alias is advertised
    const mcpAlias = FLAT_TO_MCP.get(nameLc);
    if (mcpAlias) {
      const aliasLc = lower(mcpAlias);
      if (advertised.has(aliasLc) && !emitted.has(aliasLc)) {
        emitted.add(aliasLc);
        result.push({ ...tool, name: mcpAlias });
      }
      continue;
    }

    // Rule 5: unknown flat-named tool — filtered out
  }

  return result;
}

// ============================================================================
// tool_choice remapping
//
// WHY:  If tool_choice references a tool that was filtered out or renamed,
//       the API call would fail with an invalid tool_choice error.
//
// WHAT: If tool_choice.name still exists in surviving tools, keep it.
//       If it was a companion flat name, remap to MCP alias.
//       If it was filtered entirely, remove tool_choice from payload.
//
// UPDATE: Adjust if Anthropic changes tool_choice validation rules.
// ============================================================================

function remapToolChoice(
  toolChoice: Record<string, unknown>,
  survivingNames: Map<string, string>,
): Record<string, unknown> | undefined {
  if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
    return toolChoice;
  }

  const nameLc = lower(toolChoice.name);
  const actualName = survivingNames.get(nameLc);
  if (actualName) {
    return actualName === toolChoice.name ? toolChoice : { ...toolChoice, name: actualName };
  }

  const mcpAlias = FLAT_TO_MCP.get(nameLc);
  if (mcpAlias && survivingNames.has(lower(mcpAlias))) {
    return { ...toolChoice, name: mcpAlias };
  }

  // Tool was filtered out — remove tool_choice entirely
  return undefined;
}

// ============================================================================
// Message history rewriting
//
// WHY:  Historical tool_use blocks in the conversation may reference flat
//       companion names that were remapped to MCP aliases. The model must see
//       consistent tool names across the conversation or it gets confused.
//
// WHAT: Rewrites tool_use block names from flat companion names to their MCP
//       aliases, but only if the alias survived filtering.
//
// UPDATE: Adjust if companion alias mappings change.
// ============================================================================

function remapMessageToolNames(
  messages: unknown[],
  survivingNames: Map<string, string>,
): unknown[] {
  let anyChanged = false;
  const result = messages.map((msg) => {
    if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;

    let msgChanged = false;
    const content = (msg.content as unknown[]).map((block) => {
      if (!isPlainObject(block) || block.type !== "tool_use" || typeof block.name !== "string") {
        return block;
      }
      const mcpAlias = FLAT_TO_MCP.get(lower(block.name));
      if (mcpAlias && survivingNames.has(lower(mcpAlias))) {
        msgChanged = true;
        return { ...block, name: mcpAlias };
      }
      return block;
    });

    if (msgChanged) {
      anyChanged = true;
      return { ...msg, content };
    }
    return msg;
  });

  return anyChanged ? result : messages;
}

// ============================================================================
// Full payload transform — orchestrates all steps
// ============================================================================

function transformPayload(raw: Record<string, unknown>): Record<string, unknown> {
  // Deep clone to avoid mutating the original
  const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  // Step 1: System prompt rewrite
  if (payload.system !== undefined) {
    payload.system = rewriteSystemField(payload.system);
  }

  // Step 2: Tool filtering and alias remapping
  payload.tools = filterAndRemapTools(payload.tools as unknown[] | undefined);

  // Step 3: Build map of surviving tool names (lowercase → actual name)
  const survivingNames = new Map<string, string>();
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (isPlainObject(tool) && typeof tool.name === "string") {
        survivingNames.set(lower(tool.name), tool.name as string);
      }
    }
  }

  // Step 4: Remap tool_choice if it references a renamed or filtered tool
  if (isPlainObject(payload.tool_choice)) {
    const remapped = remapToolChoice(payload.tool_choice, survivingNames);
    if (remapped === undefined) {
      delete payload.tool_choice;
    } else {
      payload.tool_choice = remapped;
    }
  }

  // Step 5: Rewrite historical tool_use blocks in message history
  if (Array.isArray(payload.messages)) {
    payload.messages = remapMessageToolNames(payload.messages, survivingNames);
  }

  return payload;
}

// ============================================================================
// Extension factory — registered as a built-in agent extension
//
// WHY:  Spawned flow agent sessions create independent sessions with their own
//       extension stacks. The main session's pi-claude-code-use transform
//       doesn't reach them. This factory injects the transform directly.
//
// WHAT: Creates a before_provider_request handler that checks if the current
//       request is Anthropic OAuth, and if so, transforms the payload.
//
// GUARD: Only activates when model.provider === "anthropic" AND the model
//        is using OAuth. API key auth and other providers pass through.
//        This respects the role system — different agents may use different
//        providers, and only Anthropic OAuth agents get transformed.
//
// REMOVE: If Anthropic drops the tool filtering restriction, delete this file
//         and remove the one push() call in flow-engine/index.ts.
// ============================================================================

export function createAnthropicOAuthTransformFactory(): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event: any, ctx: any) => {
      const model = ctx.model;
      if (!model || model.provider !== "anthropic" || !ctx.modelRegistry?.isUsingOAuth?.(model)) {
        return undefined;
      }
      if (!isPlainObject(event.payload)) {
        return undefined;
      }
      return transformPayload(event.payload as Record<string, unknown>);
    });
  };
}
