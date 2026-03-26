import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./types.js";
import { spawnAgent } from "./execution.js";

export function registerSubagentTool(
  pi: ExtensionAPI,
  getAgents: () => Map<string, AgentConfig>,
  getModelRole: (role: string) => string | undefined,
  cwd: string,
  getAuthStorage: () => AuthStorage | undefined,
  getModelRegistry: () => ModelRegistry | undefined,
  getExtraGuardFactories: () => ExtensionFactory[],
): void {
  pi.registerTool({
    name: "subagent",
    description: "Dispatch a subagent for specialized tasks. Modes: single (one agent), parallel (multiple agents).",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")]),
      agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
      task: Type.Optional(Type.String({ description: "Task description" })),
      agents: Type.Optional(Type.Array(Type.Object({
        agent: Type.String(),
        task: Type.String(),
      }), { description: "Array of {agent, task} for parallel mode" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const templateCtx = { task: params.task || "", inputs: {}, results: {}, forks: {} };
      const authStorage = getAuthStorage();
      const modelRegistry = getModelRegistry();
      const extraGuardFactories = getExtraGuardFactories();

      if (params.mode === "single" && params.agent) {
        const agentConfig = getAgents().get(params.agent);
        if (!agentConfig) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent}` }], details: {} };

        const result = await spawnAgent({
          agent: agentConfig, task: params.task || "", templateContext: templateCtx,
          getModelRole, cwd, authStorage, modelRegistry, extraGuardFactories,
        });
        return { content: [{ type: "text" as const, text: result.output }], details: {} };
      }

      if (params.mode === "parallel" && params.agents) {
        const results = await Promise.all(params.agents.map(async (entry, i) => {
          const agentConfig = getAgents().get(entry.agent);
          if (!agentConfig) return `Agent not found: ${entry.agent}`;
          const result = await spawnAgent({
            agent: agentConfig, task: entry.task, templateContext: { ...templateCtx, task: entry.task },
            getModelRole, cwd, authStorage, modelRegistry, extraGuardFactories,
          });
          return `=== Parallel Task ${i + 1} (${entry.agent}) ===\n${result.output}`;
        }));
        return { content: [{ type: "text" as const, text: results.join("\n\n") }], details: {} };
      }

      return { content: [{ type: "text" as const, text: "Invalid subagent mode or missing parameters" }], details: {} };
    },
  });
}
