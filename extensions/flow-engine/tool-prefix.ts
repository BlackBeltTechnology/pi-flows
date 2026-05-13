// ---------------------------------------------------------------------------
// Anthropic OAuth tool name prefix helpers
//
// Shared between execution.ts and guard.ts to avoid circular imports.
//
// Anthropic's OAuth endpoint only accepts tool names that match their Claude
// Code allowlist, are mcp__-prefixed, or are Anthropic-native typed tools.
// Custom pi-flows tools (finish, agent_write, etc.) must be registered with
// an mcp__ prefix so the SDK's inbound dispatch chain can match them.
//
// Detection uses messaging PROTOCOL (model.api) + TOKEN FORMAT, not provider
// name, so proxy providers are handled correctly.
// ---------------------------------------------------------------------------

/**
 * Core Claude Code tool names that Anthropic accepts without mcp__ prefix.
 * Case-insensitive. Mirrors pi-coding-agent's claudeCodeTools list in
 * packages/ai/src/providers/anthropic.ts.
 */
export const CORE_TOOL_NAMES = new Set([
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

/**
 * Apply mcp__flows__ prefix to a tool name if needed.
 * Returns the name unchanged if:
 * - prefix is empty (not Anthropic OAuth)
 * - name is in CORE_TOOL_NAMES (Anthropic accepts it)
 * - name already starts with mcp__ (already an MCP tool)
 */
export function prefixToolName(name: string, prefix: string): string {
  if (!prefix) return name;
  if (CORE_TOOL_NAMES.has(name.toLowerCase())) return name;
  if (name.startsWith("mcp__")) return name;
  return prefix + name;
}
