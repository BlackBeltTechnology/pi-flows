// ---------------------------------------------------------------------------
// Agent Catalog Tool
//
// Returns structured JSON of all discovered agents. For each agent, includes
// name, description, tools, inputs, card, and architect metadata.
// Falls back to description for use_when when architect block is absent.
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../types.js";

export function registerAgentCatalogTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
): void {
  pi.registerTool({
    name: "agent_catalog",
    description:
      "List all discovered agents with their descriptions, tools, inputs, card config, and architect metadata. Use to understand available agents before building flows.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
      const agents = getDiscoveredAgents();
      const catalog: Array<{
        name: string;
        description: string;
        tools: string[];
        inputs?: string[];
        card?: { type?: string; label?: string; metric?: string };
        architect: { use_when?: string; produces?: string; depends_on?: string; domain?: string };
      }> = [];

      for (const [_name, agent] of agents) {
        catalog.push({
          name: agent.name,
          description: agent.description,
          tools: agent.tools,
          ...(agent.inputs && agent.inputs.length > 0 ? { inputs: agent.inputs } : {}),
          ...(agent.card ? { card: agent.card } : {}),
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
