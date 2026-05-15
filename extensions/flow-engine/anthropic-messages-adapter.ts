// ---------------------------------------------------------------------------
// Adapter: run @pi/anthropic-messages against spawned subagent sessions.
//
// WHY
//   Spawned flow agent sessions build their own independent AgentSession with
//   its own extension stack; the main session's extensions do not reach them.
//   To get the same anthropic-messages payload/response transforms (mcp__
//   prefixing of custom tools, inbound response translation, system-prompt
//   compat shims) we run the package's default export against each subagent's
//   pi API at spawn time.
//
// WHAT
//   A dynamic-import adapter. `@pi/anthropic-messages` is an optional
//   dependency: if it is not installed this file is a no-op.
//
// DIRECTION
//   pi-flows (host) → pi-anthropic-messages (leaf). The leaf does not know
//   about pi-flows; all coupling lives here. See the project README /
//   discussion for rationale (option B in the design discussion).
//
// LEGACY
//   Earlier versions of this adapter dynamic-imported
//   `@benvargas/pi-claude-code-use`. That package is superseded by
//   `@pi/anthropic-messages` in this repo; the old import is gone. If you
//   still need the legacy package for another project, add a second adapter
//   entry in extraAgentExtensions.
// ---------------------------------------------------------------------------

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const anthropicMessagesAgentFactory: ExtensionFactory = async (pi) => {
  try {
    const mod = await import("@pi/anthropic-messages");
    if (typeof mod.default === "function") {
      await mod.default(pi);
    }
  } catch {
    // Package not installed — subagents run without the anthropic-messages
    // transform, same as the main session when the package is absent.
  }
};
