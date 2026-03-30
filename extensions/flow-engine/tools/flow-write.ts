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
import { dirname } from "node:path";

export function registerFlowWriteTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
): void {
  pi.registerTool({
    name: "flow_write",
    description:
      "Validate and write a flow YAML file. Runs flow_validate internally first. If validation passes, writes the file to the specified path. Returns errors if invalid.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to write the flow .yaml file" }),
      content: Type.String({ description: "The flow YAML content to validate and write" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      // Run validation first
      const validation = validateFlowContent(params.content, getDiscoveredAgents);

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

      // Trigger re-discovery so the new flow is available immediately
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
