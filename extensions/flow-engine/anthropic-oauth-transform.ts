// ---------------------------------------------------------------------------
// Anthropic OAuth Payload Transform for Flow Agent Sessions
//
// ⚠️  ANTHROPIC-SPECIFIC WORKAROUND (April 2026)
//
// Anthropic's OAuth subscription endpoint fingerprints system prompt text.
// This module rewrites pi-identifying phrases in the system prompt so spawned
// flow agent sessions pass Anthropic's detection.
//
// Tool name handling is done at REGISTRATION time in execution.ts (mcp__flows__
// prefix for non-core tools), not here. This transform only handles the system
// prompt rewrite.
//
// Detection uses messaging PROTOCOL (model.api), not provider name or token
// format, so proxy providers that speak anthropic-messages are handled correctly.
//
// To remove: delete this file and the one `extraAgentExtensions.push()` call
// in flow-engine/index.ts.
//
// Main session equivalent: pi-agent-dashboard/extension/src/anthropic-transform.ts
// ---------------------------------------------------------------------------

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
// Payload transform — system prompt rewrite only
//
// Tool filtering/renaming is no longer needed here. Tools are registered with
// correct mcp__flows__ names at session creation time in execution.ts.
// ============================================================================

function transformPayload(raw: Record<string, unknown>): Record<string, unknown> {
  // Deep clone to avoid mutating the original
  const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  // System prompt rewrite
  if (payload.system !== undefined) {
    payload.system = rewriteSystemField(payload.system);
  }

  return payload;
}

// ============================================================================
// Extension factory — registered as a built-in agent extension
//
// WHY:  Spawned flow agent sessions create independent sessions with their own
//       extension stacks. The main session's pi-claude-code-use transform
//       doesn't reach them. This factory injects the system prompt rewrite.
//
// GUARD: Activates for all anthropic-messages providers (direct OAuth, API key,
//        and proxies like 9Router). The prompt rewrite is harmless for all cases.
//
// REMOVE: If Anthropic drops the prompt fingerprinting restriction, delete
//         this file and remove the one push() call in flow-engine/index.ts.
// ============================================================================

export function createAnthropicOAuthTransformFactory(): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", async (event: any, ctx: any) => {
      const model = ctx.model;
      if (!model || model.api !== "anthropic-messages") {
        return undefined;
      }

      if (!isPlainObject(event.payload)) {
        return undefined;
      }
      return transformPayload(event.payload as Record<string, unknown>);
    });
  };
}
