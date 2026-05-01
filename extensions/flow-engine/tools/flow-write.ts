// ---------------------------------------------------------------------------
// Flow Write Tool
//
// Validates flow YAML content via flow-validate, then writes to disk if valid.
// Emits "flow:rediscover" event after successful write to trigger re-discovery.
// Returns validation errors if the content is invalid.
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../types.js";
import { validateFlowContent } from "./flow-validate.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function registerFlowWriteTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
  projectRoot?: string,
): void {
  pi.registerTool({
    name: "flow_write",
    description:
      "Validate and write a flow YAML file. Use 'path' for the full file path (e.g. '.pi/flows/.staging/flows/my-flow.yaml') or 'name' for a bare flow name (e.g. 'my-flow'). Validates content first; if valid, writes the file.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Absolute or relative path to write the flow .yaml file" })),
      name: Type.Optional(Type.String({ description: "Flow name or path (alias for path)" })),
      content: Type.String({ description: "The flow YAML content to validate and write" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      // Accept 'name' as alias for 'path'; expand bare names to staging path
      let rawPath = (params as any).path || (params as any).name || "";
      if (rawPath && !rawPath.includes("/") && !rawPath.includes("\\")) {
        const stem = rawPath.endsWith(".yaml") || rawPath.endsWith(".yml") ? rawPath : `${rawPath}.yaml`;
        rawPath = `.pi/flows/.staging/flows/${stem}`;
      }
      const filePath = rawPath;

      // Run validation first
      const validation = validateFlowContent(params.content, getDiscoveredAgents);

      if (!validation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                written: false,
                path: filePath,
                diagnostics: validation.diagnostics,
              }, null, 2),
            },
          ],
          details: {},
        };
      }

      // Resolve relative paths against projectRoot
      const absPath = projectRoot ? resolve(projectRoot, filePath) : filePath;

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

      // Trigger re-discovery so the new flow is available immediately
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
