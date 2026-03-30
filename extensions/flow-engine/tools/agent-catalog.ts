// ---------------------------------------------------------------------------
// Agent Catalog Tool
//
// Returns structured JSON of all discovered agents. For each agent, includes
// name, description, tools, inputs, card, source info, and architect metadata.
// Falls back to description for use_when when architect block is absent.
// Agents with source_type "local" are project-specific agents (in .pi/flows/).
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../types.js";
import { join } from "node:path";

/**
 * Classify an agent's source path as "local" (project .pi/flows/),
 * "package" (registered by dependent packages), or "built-in" (pi-flows).
 */
function classifyAgentSource(
  agent: AgentConfig,
  projectRoot: string,
  packageRoot: string,
  extraAgentsDirs: string[],
): "local" | "package" | "built-in" {
  const src = agent.source;
  if (!src) return "built-in";
  const piLocal = join(projectRoot, ".pi");
  if (src.startsWith(piLocal)) return "local";
  for (const dir of extraAgentsDirs) {
    if (src.startsWith(dir)) return "package";
  }
  if (src.startsWith(packageRoot)) return "built-in";
  return "built-in";
}

export function registerAgentCatalogTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
  projectRoot?: string,
  packageRoot?: string,
  getExtraAgentsDirs?: () => string[],
): void {
  pi.registerTool({
    name: "agent_catalog",
    description:
      "List all discovered agents with their descriptions, tools, inputs, card config, source info, and architect metadata. Use to understand available agents before building flows. Agents with source_type \"local\" are project-specific custom agents that can be read and modified with agent_write.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      const agents = getDiscoveredAgents();
      const extraDirs = getExtraAgentsDirs ? getExtraAgentsDirs() : [];
      const catalog: Array<{
        name: string;
        description: string;
        tools: string[];
        inputs?: string[];
        outputs?: Array<{name: string, description?: string}>;
        card?: { type?: string; label?: string; metric?: string };
        source_type: "local" | "package" | "built-in";
        source_path?: string;
        architect: { use_when?: string; produces?: string; depends_on?: string; domain?: string };
      }> = [];

      for (const [_name, agent] of agents) {
        const sourceType = projectRoot && packageRoot
          ? classifyAgentSource(agent, projectRoot, packageRoot, extraDirs)
          : "built-in";

        catalog.push({
          name: agent.name,
          description: agent.description,
          tools: agent.tools,
          ...(agent.inputs && agent.inputs.length > 0 ? { inputs: agent.inputs } : {}),
          ...(agent.outputs && agent.outputs.length > 0 ? { outputs: agent.outputs } : {}),
          ...(agent.card ? { card: agent.card } : {}),
          source_type: sourceType,
          // Include path for local/package agents so architect can read/modify them
          ...(sourceType !== "built-in" && agent.source ? { source_path: agent.source } : {}),
          architect: agent.architect
            ? {
                use_when: agent.architect.use_when,
                produces: agent.architect.produces,
                depends_on: agent.architect.depends_on,
                domain: agent.architect.domain,
              }
            : {
                // Fallback: use description as use_when when no architect block
                use_when: agent.description,
              },
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(catalog, null, 2),
          },
        ],
        details: {},
      };
    },
  });
}
