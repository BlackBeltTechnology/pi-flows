// ---------------------------------------------------------------------------
// Agent Write Tool
//
// Validates agent .md content via agent-validate, then writes to disk if valid.
// Emits "flow:rediscover" event after successful write to trigger re-discovery.
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { validateAgentContent } from "./agent-validate.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function registerAgentWriteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agent_write",
    description:
      "Validate and write an agent .md file. Validates internally first. If validation passes, writes the file and triggers agent re-discovery. Returns errors if invalid.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to write the agent .md file" }),
      content: Type.String({ description: "The agent .md content to validate and write" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      // Run validation first (with dynamically discovered tools)
      const dynamicTools = new Set(pi.getAllTools().map(t => t.name));
      const validation = validateAgentContent(params.content, dynamicTools);

      if (!validation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                written: false,
                path: params.path,
                diagnostics: validation.diagnostics,
              }, null, 2),
            },
          ],
          details: {},
        };
      }

      // Ensure directory exists and write the file
      try {
        mkdirSync(dirname(params.path), { recursive: true });
        writeFileSync(params.path, params.content, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                written: false,
                path: params.path,
                error: err instanceof Error ? err.message : String(err),
              }, null, 2),
            },
          ],
          details: {},
        };
      }

      // Trigger re-discovery so the new agent is available immediately
      pi.events.emit("flow:rediscover", {});

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              written: true,
              path: params.path,
              diagnostics: validation.diagnostics,
            }, null, 2),
          },
        ],
        details: {},
      };
    },
  });
}
