// ---------------------------------------------------------------------------
// flow_agents Tool — list + write agents (discovery-based, no raw paths)
//
// op: "list"  — returns the agent catalog (name, description, tools, inputs,
//               card, source info, architect metadata). Replaces agent_catalog.
// op: "write" — validates content via agent-validate.ts, then writes to the
//               discovered location .pi/flows/agents/<name>.md and triggers
//               re-discovery. Replaces agent_write. No raw `path` param — the
//               filename is derived from the agent's frontmatter `name`.
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types.js";
import { validateAgentContent } from "./agent-validate.js";
import { writeFileSync, mkdirSync } from "node:fs";
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

/** Extract the agent `name` from YAML frontmatter, if present. */
function extractAgentName(content: string): string | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const block = fmMatch ? fmMatch[1] : content;
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  return nameMatch[1].trim().replace(/^["']|["']$/g, "");
}

export function registerFlowAgentsTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
  projectRoot: string,
  packageRoot: string,
  getExtraAgentsDirs: () => string[],
): void {
  pi.registerTool({
    name: "flow_agents",
    label: "flow_agents",
    description:
      "List or write flow agents. op \"list\" returns the agent catalog " +
      "(name, description, tools, inputs, card, source info, architect metadata) — " +
      "use it before creating/editing a flow. op \"write\" validates an agent .md " +
      "definition and, on success, writes it to .pi/flows/agents/<name>.md (the " +
      "filename is derived from the agent's frontmatter name) and triggers " +
      "re-discovery. Returns validation diagnostics on failure. Overwriting an " +
      "existing agent edits it.",
    parameters: Type.Object({
      op: Type.Union([Type.Literal("list"), Type.Literal("write")], {
        description: "\"list\" to read the agent catalog, \"write\" to create/edit an agent",
      }),
      content: Type.Optional(
        Type.String({ description: "Agent .md content (required for op \"write\")" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const { op, content } = params as { op: "list" | "write"; content?: string };

      // -- list --
      if (op === "list") {
        const agents = getDiscoveredAgents();
        const extraDirs = getExtraAgentsDirs();
        const catalog: Array<Record<string, unknown>> = [];

        for (const [, agent] of agents) {
          const sourceType = classifyAgentSource(agent, projectRoot, packageRoot, extraDirs);
          catalog.push({
            name: agent.name,
            description: agent.description,
            tools: agent.tools,
            ...(agent.inputs && agent.inputs.length > 0 ? { inputs: agent.inputs } : {}),
            ...(agent.outputs && agent.outputs.length > 0 ? { outputs: agent.outputs } : {}),
            ...(agent.card ? { card: agent.card } : {}),
            source_type: sourceType,
            ...(sourceType !== "built-in" && agent.source ? { source_path: agent.source } : {}),
            architect: agent.architect
              ? {
                  use_when: agent.architect.use_when,
                  produces: agent.architect.produces,
                  depends_on: agent.architect.depends_on,
                  domain: agent.architect.domain,
                }
              : { use_when: agent.description },
          });
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }],
          details: {},
        };
      }

      // -- write --
      if (!content) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: "content is required for op \"write\"" }, null, 2) }],
          details: {},
        };
      }

      // Validate first (with dynamically discovered tool names)
      const dynamicTools = new Set(pi.getAllTools().map(t => t.name));
      const validation = validateAgentContent(content, dynamicTools);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, diagnostics: validation.diagnostics }, null, 2) }],
          details: {},
        };
      }

      // Derive the filename from the frontmatter name
      const name = extractAgentName(content);
      if (!name) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: "Could not determine agent name from frontmatter (missing 'name:' field)" }, null, 2) }],
          details: {},
        };
      }

      const agentsDir = join(projectRoot, ".pi", "flows", "agents");
      const filePath = join(agentsDir, `${name}.md`);
      try {
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(filePath, content, "utf-8");
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: err instanceof Error ? err.message : String(err) }, null, 2) }],
          details: {},
        };
      }

      pi.events.emit("flow:rediscover", {});

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ written: true, name, path: filePath, diagnostics: validation.diagnostics }, null, 2) }],
        details: {},
      };
    },
  });
}
