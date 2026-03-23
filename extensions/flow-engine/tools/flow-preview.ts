// ---------------------------------------------------------------------------
// Flow Preview Tool
//
// Renders a text preview of a flow showing: name, description, steps with
// labels/descriptions, dependency arrows, and custom agents. Presents a
// choice to the user: Run, Save & Run, Replan, or Cancel.
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, FlowConfig, FlowStep, AgentStep, ForkStep, ConditionalStep, AgentDecisionStep, FlowRefStep } from "../types.js";
import { parseFlowString } from "../flow-parser.js";

// ---- Preview rendering ----------------------------------------------------

function renderFlowPreview(flow: FlowConfig, knownAgents: Map<string, AgentConfig>): string {
  const lines: string[] = [];

  lines.push(`Flow: ${flow.name}`);
  lines.push(`Description: ${flow.description}`);
  if (flow.max_concurrent) {
    lines.push(`Max concurrent: ${flow.max_concurrent}`);
  }
  lines.push("");
  lines.push("Steps:");
  lines.push("------");

  const customAgents: string[] = [];

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const num = i + 1;

    switch (step.stepType) {
      case "agent": {
        const agentStep = step as AgentStep;
        const isKnown = knownAgents.has(agentStep.agent);
        const marker = isKnown ? "" : " [NEW]";
        if (!isKnown) customAgents.push(agentStep.agent);

        lines.push(`  ${num}. [agent] ${agentStep.id}${marker}`);
        if (agentStep.task) {
          lines.push(`     task: ${truncate(agentStep.task, 80)}`);
        }
        if (agentStep.model) {
          lines.push(`     model: ${agentStep.model}`);
        }
        if (agentStep.blockedBy && agentStep.blockedBy.length > 0) {
          lines.push(`     blockedBy: ${agentStep.blockedBy.join(", ")}`);
        }
        if (agentStep.inputs && Object.keys(agentStep.inputs).length > 0) {
          for (const [key, val] of Object.entries(agentStep.inputs)) {
            lines.push(`     input.${key}: ${truncate(val, 60)}`);
          }
        }
        if (agentStep.output) {
          lines.push(`     output: ${agentStep.output}`);
        }
        if (agentStep.on_complete) {
          lines.push(`     -> on_complete: ${agentStep.on_complete}`);
        }
        if (agentStep.on_error) {
          lines.push(`     -> on_error: ${agentStep.on_error}`);
        }
        break;
      }

      case "fork": {
        const forkStep = step as ForkStep;
        lines.push(`  ${num}. [fork] ${forkStep.id}`);
        lines.push(`     question: ${truncate(forkStep.question, 80)}`);
        lines.push(`     options: ${forkStep.options.join(", ")}`);
        if (forkStep.branches && Object.keys(forkStep.branches).length > 0) {
          for (const [option, target] of Object.entries(forkStep.branches)) {
            lines.push(`     "${option}" -> ${target}`);
          }
        }
        break;
      }

      case "conditional": {
        const condStep = step as ConditionalStep;
        lines.push(`  ${num}. [conditional] ${condStep.id}`);
        lines.push(`     check: ${condStep.check}`);
        lines.push(`     present -> ${condStep.present}`);
        lines.push(`     absent  -> ${condStep.absent}`);
        break;
      }

      case "agent-decision": {
        const adStep = step as AgentDecisionStep;
        lines.push(`  ${num}. [agent-decision] ${adStep.id}`);
        lines.push(`     agent: ${adStep.agent}`);
        lines.push(`     task: ${truncate(adStep.task, 80)}`);
        if (adStep.branches && Object.keys(adStep.branches).length > 0) {
          for (const [branch, target] of Object.entries(adStep.branches)) {
            lines.push(`     "${branch}" -> ${target}`);
          }
        }
        break;
      }

      case "flow-ref": {
        const frStep = step as FlowRefStep;
        lines.push(`  ${num}. [flow-ref] ${frStep.id}`);
        lines.push(`     path: ${frStep.path}`);
        if (frStep.on_complete) {
          lines.push(`     -> on_complete: ${frStep.on_complete}`);
        }
        if (frStep.on_error) {
          lines.push(`     -> on_error: ${frStep.on_error}`);
        }
        break;
      }
    }

    lines.push("");
  }

  // Show dependency graph summary
  const agentSteps = flow.steps.filter((s): s is AgentStep => s.stepType === "agent");
  const depsExist = agentSteps.some((s) => s.blockedBy && s.blockedBy.length > 0);
  if (depsExist) {
    lines.push("Dependency Graph:");
    for (const step of agentSteps) {
      if (step.blockedBy && step.blockedBy.length > 0) {
        for (const dep of step.blockedBy) {
          lines.push(`  ${dep} --> ${step.id}`);
        }
      }
    }
    lines.push("");
  }

  // Show custom agents that need to be created
  const uniqueCustom = [...new Set(customAgents)];
  if (uniqueCustom.length > 0) {
    lines.push("Custom agents (will be created):");
    for (const name of uniqueCustom) {
      lines.push(`  - ${name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

// ---- Tool registration ----------------------------------------------------

export function registerFlowPreviewTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
): void {
  pi.registerTool({
    name: "flow_preview",
    description:
      "Preview a flow by rendering its steps, dependencies, and custom agents as formatted text. Returns the preview — the orchestrator handles user approval.",
    parameters: Type.Object({
      content: Type.String({ description: "The flow .md content to preview" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      // Parse the flow content
      let flow: FlowConfig;
      try {
        flow = parseFlowString(params.content, "<preview>");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }, null, 2),
            },
          ],
          details: {},
        };
      }

      // Render the preview (no UI — choice is handled by the parent orchestrator)
      const preview = renderFlowPreview(flow, getDiscoveredAgents());

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ preview }, null, 2),
          },
        ],
        details: {},
      };
    },
  });
}
