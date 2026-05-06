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
import { dirname, resolve } from "node:path";

export function registerAgentWriteTool(pi: ExtensionAPI, projectRoot?: string): void {
  pi.registerTool({
    name: "agent_write",
    description:
      "Validate and write an agent .md file. Use 'path' for the full file path (e.g. '.pi/flows/.staging/agents/my-agent.md') or 'name' for a bare agent name (e.g. 'my-agent'). Validates content first; if valid, writes the file and triggers re-discovery.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Absolute or relative path to write the agent .md file" })),
      name: Type.Optional(Type.String({ description: "Agent name or path (alias for path)" })),
      content: Type.String({ description: "The agent .md content to validate and write" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      // Accept 'name' as alias for 'path'; expand bare names to staging path
      let rawPath = (params as any).path || (params as any).name || "";
      if (rawPath && !rawPath.includes("/") && !rawPath.includes("\\")) {
        const stem = rawPath.endsWith(".md") ? rawPath : `${rawPath}.md`;
        rawPath = `.pi/flows/.staging/agents/${stem}`;
      }
      const filePath = rawPath;
      const absPath = projectRoot ? resolve(projectRoot, filePath) : filePath;

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
                path: absPath,
                diagnostics: validation.diagnostics,
              }, null, 2),
            },
          ],
          details: {},
        };
      }

      try {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, params.content, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                written: false,
                path: absPath,
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
              path: absPath,
              diagnostics: validation.diagnostics,
            }, null, 2),
          },
        ],
        details: {},
      };
    },
  });
}
