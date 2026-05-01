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

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";

// Known install paths for pi-anthropic-messages, in priority order.
const CANDIDATE_PATHS = [
  join(homedir(), ".pi", "agent", "git", "github.com", "BlackBeltTechnology", "pi-anthropic-messages", "extensions", "index.ts"),
  join(homedir(), ".pi", "agent", "git", "github.com", "BlackBeltTechnology", "pi-anthropic-messages", "extensions", "index.js"),
];

export const anthropicMessagesAgentFactory: ExtensionFactory = async (pi) => {
  // First try the package name (works when installed as npm dep or alias)
  try {
    const mod = await import("@pi/anthropic-messages");
    if (typeof mod.default === "function") {
      await mod.default(pi);
      return;
    }
  } catch {
    // Not available as a package — fall through to path-based resolution
  }

  // Fall back to known install paths
  for (const candidate of CANDIDATE_PATHS) {
    try {
      const mod = await import(candidate);
      if (typeof mod.default === "function") {
        await mod.default(pi);
        return;
      }
    } catch {
      // Try next candidate
    }
  }
};
