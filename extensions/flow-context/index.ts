// ---------------------------------------------------------------------------
// Flow Context Extension
//
// Provides flow result management and tool-based access:
//   - flow_results tool — LLM-callable tool for reading flow results
//   - /flows <name> — action menu (inject / edit / delete)
//   - /flows:delete <name> — delete a flow result + flow file
// ---------------------------------------------------------------------------

import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";

function getFlowResultNames(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) return [];
  try {
    return readdirSync(resultsDir)
      .filter(f => f.endsWith(".md"))
      .map(f => basename(f, ".md"));
  } catch {
    return [];
  }
}

function getFlowFiles(projectRoot: string): { name: string; path: string }[] {
  const flowFiles: { name: string; path: string }[] = [];

  // Saved flows — scan .pi/flows/flows/ with one level of subfolders
  const savedFlowsDir = join(projectRoot, ".pi", "flows", "flows");
  if (existsSync(savedFlowsDir)) {
    try {
      for (const entry of readdirSync(savedFlowsDir)) {
        const entryPath = join(savedFlowsDir, entry);
        if (entry.endsWith(".yaml")) {
          // Top-level flow file
          flowFiles.push({ name: entry.replace(".yaml", ""), path: entryPath });
        } else {
          // Check for subfolder (one level deep only)
          try {
            const stat = statSync(entryPath);
            if (stat.isDirectory()) {
              for (const sub of readdirSync(entryPath)) {
                if (sub.endsWith(".yaml")) {
                  const name = `${entry}:${sub.replace(".yaml", "")}`;
                  flowFiles.push({ name, path: join(entryPath, sub) });
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  return flowFiles;
}

function flowResultCompletions(resultsDir: string, prefix: string): AutocompleteItem[] | null {
  const names = getFlowResultNames(resultsDir);
  const filtered = prefix
    ? names.filter(f => f.startsWith(prefix) || f.includes(prefix))
    : names;
  if (filtered.length === 0) return null;
  return filtered.map(name => ({
    value: name,
    label: name,
    description: "Flow result",
  }));
}

// -- Delete logic (pure — no ctx.ui dependency) ------------------------------

function deleteFlowFiles(
  pi: ExtensionAPI,
  projectRoot: string,
  flowName: string,
  flowPath: string,
): { success: boolean; error?: string } {
  // Read flow before deletion to identify agent references
  let agentNames: string[] = [];
  try {
    const content = readFileSync(flowPath, "utf-8");
    const agentMatches = content.matchAll(/^## ([\w][\w-]*)$/gm);
    for (const m of agentMatches) {
      agentNames.push(m[1]);
    }
  } catch { /* ignore */ }

  // Delete the flow file
  try {
    rmSync(flowPath);
  } catch (err: any) {
    return { success: false, error: `Failed to delete flow: ${err.message}` };
  }

  // Delete associated custom agents in .pi/flows/agents/
  const piAgentsDir = join(projectRoot, ".pi", "flows", "agents");
  if (existsSync(piAgentsDir)) {
    for (const agentName of agentNames) {
      const agentPath = join(piAgentsDir, `${agentName}.md`);
      try {
        if (existsSync(agentPath)) rmSync(agentPath);
      } catch { /* ignore */ }
    }
  }

  // Clean up result files
  const resultsDir = join(projectRoot, ".pi", "flows", "results");
  try {
    const mdPath = join(resultsDir, `${flowName}.md`);
    const jsonPath = join(resultsDir, `${flowName}.json`);
    if (existsSync(mdPath)) rmSync(mdPath);
    if (existsSync(jsonPath)) rmSync(jsonPath);
  } catch { /* ignore */ }

  // Tombstone the deleted flow's command so it disappears from autocomplete
  pi.registerCommand(flowName, { handler: async () => {} });

  // Re-discover to update flow state
  pi.events.emit("flow:rediscover", {});

  return { success: true };
}

// -- Extension entry point --------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  const resultsDir = join(projectRoot, ".pi", "flows", "results");

  // -- Event API: flow:delete-request -----------------------------------------

  pi.events.on("flow:delete-request", (data: any) => {
    const flowName = data?.flowName;
    if (!flowName) return;

    const flowFiles = getFlowFiles(projectRoot);
    const matching = flowFiles.find(f => f.name === flowName);
    if (!matching) return;

    deleteFlowFiles(pi, projectRoot, flowName, matching.path);
  });

  // -- flow_results tool — LLM-callable access to flow results ----------------

  const MAX_FULL_OUTPUT = 10_000;

  pi.registerTool({
    name: "flow_results",
    label: "Flow Results",
    description:
      "Read flow execution results. Use action 'list' to see available results, " +
      "'summary' to get per-agent summaries for a flow, or 'agent' to get full " +
      "detail for a specific agent within a flow.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("summary"),
        Type.Literal("agent"),
      ], { description: "Action: 'list' all results, 'summary' per-agent summaries, 'agent' full detail for one agent" }),
      flow: Type.Optional(Type.String({ description: "Flow name (required for summary and agent actions)" })),
      agent: Type.Optional(Type.String({ description: "Agent/step name (required for agent action)" })),
    }),
    execute: async (_toolCallId, params) => {
      const { action, flow, agent } = params as { action: string; flow?: string; agent?: string };

      // -- list action --
      if (action === "list") {
        if (!existsSync(resultsDir)) {
          return { content: [{ type: "text" as const, text: "No flow results available." }], details: {} };
        }
        let jsonFiles: string[];
        try {
          jsonFiles = readdirSync(resultsDir).filter(f => f.endsWith(".json"));
        } catch {
          return { content: [{ type: "text" as const, text: "No flow results available." }], details: {} };
        }
        if (jsonFiles.length === 0) {
          return { content: [{ type: "text" as const, text: "No flow results available." }], details: {} };
        }

        const lines: string[] = ["Available flow results:", ""];
        for (const file of jsonFiles) {
          const name = basename(file, ".json");
          try {
            const stat = statSync(join(resultsDir, file));
            const ts = stat.mtime.toISOString().replace("T", " ").slice(0, 19);
            lines.push(`• ${name}  (${ts})`);
          } catch {
            lines.push(`• ${name}`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
      }

      // -- summary and agent actions require flow param --
      if (!flow) {
        return { content: [{ type: "text" as const, text: `Error: 'flow' parameter is required for action '${action}'.` }], details: {} };
      }

      const jsonPath = join(resultsDir, `${flow}.json`);
      if (!existsSync(jsonPath)) {
        return { content: [{ type: "text" as const, text: `Error: No flow result found for "${flow}".` }], details: {} };
      }

      let flowResult: any;
      try {
        flowResult = JSON.parse(readFileSync(jsonPath, "utf-8"));
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: Failed to parse flow result: ${err.message}` }], details: {} };
      }

      const results: Record<string, any> = flowResult.results || {};

      // -- summary action --
      if (action === "summary") {
        const lines: string[] = [`Flow: ${flow}`, ""];
        const entries = Object.entries(results);
        if (entries.length === 0) {
          lines.push("No agent results found.");
        } else {
          for (const [stepId, r] of entries) {
            const status = r.status || "unknown";
            lines.push(`## ${stepId} (${status})`);
            if (r.summary) lines.push(`Summary: ${r.summary}`);
            if (r.files) lines.push(`Files: ${r.files}`);
            lines.push("");
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
      }

      // -- agent action --
      if (action === "agent") {
        if (!agent) {
          return { content: [{ type: "text" as const, text: `Error: 'agent' parameter is required for action 'agent'.` }], details: {} };
        }

        const agentResult = results[agent];
        if (!agentResult) {
          const available = Object.keys(results);
          return {
            content: [{ type: "text" as const, text: `Error: Agent "${agent}" not found in flow "${flow}". Available agents: ${available.join(", ")}` }],
            details: {},
          };
        }

        const lines: string[] = [`Agent: ${agent}`, `Status: ${agentResult.status || "unknown"}`, ""];
        if (agentResult.summary) {
          lines.push(`## Summary`, agentResult.summary, "");
        }
        if (agentResult.fullOutput) {
          let output = agentResult.fullOutput;
          if (output.length > MAX_FULL_OUTPUT) {
            output = output.slice(0, MAX_FULL_OUTPUT) + `\n\n[Output truncated at ${MAX_FULL_OUTPUT} characters]`;
          }
          lines.push(`## Full Output`, output, "");
        }
        if (agentResult.artifacts) {
          lines.push(`## Artifacts`, agentResult.artifacts, "");
        }
        if (agentResult.files) {
          lines.push(`## Files`, agentResult.files, "");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
      }

      return { content: [{ type: "text" as const, text: `Error: Unknown action '${action}'.` }], details: {} };
    },
  });

  // -- /flows <name> — action menu ------------------------------------------

  pi.registerCommand("flows", {
    description: "Manage flow results — inject context, edit, or delete",
    getArgumentCompletions: (prefix: string) => flowResultCompletions(resultsDir, prefix),
    handler: async (args, ctx) => {
      const name = args?.trim();

      if (!name) {
        // Show action menu
        const names = getFlowResultNames(resultsDir);
        const flowFiles = getFlowFiles(projectRoot);
        const hasFlows = names.length > 0 || flowFiles.length > 0;

        const options = ["New flow"];
        if (hasFlows) options.push("List flows");
        options.push("Cancel");

        const topAction = await ctx.ui.select("Flows", options);
        if (!topAction || topAction === "Cancel") return;

        if (topAction === "New flow") {
          const description = await ctx.ui.input("Describe what the flow should do:", "") || "";
          if (!description) {
            ctx.ui.notify("Cancelled.", "warning");
            return;
          }
          pi.events.emit("flows:new-request", { description });
          return;
        }

        if (topAction === "List flows") {
          const allNames = [...new Set([...names, ...flowFiles.map(f => f.name)])];
          ctx.ui.notify(
            `Available flows:\n${allNames.map(f => `  • ${f}`).join("\n")}\n\nUse /flows <name> for actions.`,
            "info",
          );
          return;
        }
        return;
      }

      // Check what exists for this name
      const hasResult = existsSync(join(resultsDir, `${name}.md`));
      const flowFiles = getFlowFiles(projectRoot);
      const matchingFlow = flowFiles.find(f => f.name === name);

      if (!hasResult && !matchingFlow) {
        ctx.ui.notify(`No flow result or flow file found for "${name}".`, "warning");
        return;
      }

      // Build action menu with descriptions
      const actionItems: SelectItem[] = [];
      if (hasResult) actionItems.push({ value: "inject", label: "Inject context", description: "Add flow result to conversation" });
      if (matchingFlow) actionItems.push({ value: "edit", label: "Edit", description: "Open in flow architect" });
      if (hasResult || matchingFlow) actionItems.push({ value: "delete", label: "Delete", description: "Remove flow and results" });

      const { selectOverlay } = await import("../shared/select-overlay.js");
      const action = await selectOverlay(ctx, `Flow: "${name}"`, actionItems);
      if (!action) return;

      if (action === "inject") {
        pi.sendUserMessage(`Read the flow results for "${name}"`);
      } else if (action === "edit") {
        // Delegate to flow-engine via event
        pi.events.emit("flows:edit-request", { flowName: name, flowPath: matchingFlow!.path });
      } else if (action === "delete") {
        const confirmed = await ctx.ui.confirm(`Delete flow "${name}"?`, "");
        if (!confirmed) {
          ctx.ui.notify("Cancelled.", "warning");
          return;
        }
        if (matchingFlow) {
          const result = deleteFlowFiles(pi, projectRoot, name, matchingFlow.path);
          if (result.success) {
            ctx.ui.notify(`Flow "${name}" deleted.`, "info");
          } else {
            ctx.ui.notify(result.error || "Failed to delete flow", "error");
          }
        } else if (hasResult) {
          // Only result files exist (no flow file)
          try {
            const mdPath = join(resultsDir, `${name}.md`);
            const jsonPath = join(resultsDir, `${name}.json`);
            if (existsSync(mdPath)) rmSync(mdPath);
            if (existsSync(jsonPath)) rmSync(jsonPath);
            ctx.ui.notify(`Flow result "${name}" deleted.`, "info");
          } catch (err: any) {
            ctx.ui.notify(`Failed to delete: ${err.message}`, "error");
          }
        }
      }
    },
  });

  // -- /flows:delete <name> — direct delete ---------------------------------

  pi.registerCommand("flows:delete", {
    description: "Delete a saved flow and its results",
    getArgumentCompletions: (prefix: string) => {
      const flowFiles = getFlowFiles(projectRoot);
      const names = flowFiles.map(f => f.name);
      // Also include result-only names
      const resultNames = getFlowResultNames(resultsDir);
      const allNames = [...new Set([...names, ...resultNames])];
      const filtered = prefix
        ? allNames.filter(f => f.startsWith(prefix) || f.includes(prefix))
        : allNames;
      if (filtered.length === 0) return null;
      return filtered.map(name => ({
        value: name,
        label: name,
        description: "Flow",
      }));
    },
    handler: async (args, ctx) => {
      let name = args?.trim();

      if (!name) {
        // Show selection with descriptions
        const flowFiles = getFlowFiles(projectRoot);
        const resultNames = getFlowResultNames(resultsDir);
        const flowNameSet = new Set(flowFiles.map(f => f.name));
        const allNames = [...new Set([...flowFiles.map(f => f.name), ...resultNames])];

        if (allNames.length === 0) {
          ctx.ui.notify("No flows found to delete.", "info");
          return;
        }

        const deleteItems: SelectItem[] = allNames.map((n) => ({
          value: n,
          label: n,
          description: flowNameSet.has(n) ? "Flow file" : "Result only",
        }));

        const { selectOverlay } = await import("../shared/select-overlay.js");
        name = await selectOverlay(ctx, "Select flow to delete", deleteItems) || "";
        if (!name) {
          ctx.ui.notify("Cancelled.", "warning");
          return;
        }
      }

      const flowFiles = getFlowFiles(projectRoot);
      const matchingFlow = flowFiles.find(f => f.name === name);

      const confirmed = await ctx.ui.confirm(`Delete flow "${name}"?`, "");
      if (!confirmed) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }

      if (matchingFlow) {
        const result = deleteFlowFiles(pi, projectRoot, name, matchingFlow.path);
        if (result.success) {
          ctx.ui.notify(`Flow "${name}" deleted.`, "info");
        } else {
          ctx.ui.notify(result.error || "Failed to delete flow", "error");
        }
      } else {
        // Result-only cleanup
        try {
          const mdPath = join(resultsDir, `${name}.md`);
          const jsonPath = join(resultsDir, `${name}.json`);
          if (existsSync(mdPath)) rmSync(mdPath);
          if (existsSync(jsonPath)) rmSync(jsonPath);
          ctx.ui.notify(`Flow result "${name}" deleted.`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to delete: ${err.message}`, "error");
        }
      }
    },
  });

  // -- /flows:edit <name> — delegate to flow-engine --------------------

  pi.registerCommand("flows:edit", {
    description: "Edit an existing flow via the flow architect",
    getArgumentCompletions: (prefix: string) => {
      const flowFiles = getFlowFiles(projectRoot);
      const filtered = prefix
        ? flowFiles.filter(f => f.name.startsWith(prefix) || f.name.includes(prefix))
        : flowFiles;
      if (filtered.length === 0) return null;
      return filtered.map(f => ({
        value: f.name,
        label: f.name,
        description: "Flow",
      }));
    },
    handler: async (args, ctx) => {
      let name = args?.trim();

      if (!name) {
        const flowFiles = getFlowFiles(projectRoot);
        if (flowFiles.length === 0) {
          ctx.ui.notify("No flows found to edit.", "info");
          return;
        }
        name = await ctx.ui.select("Select flow to edit:", flowFiles.map(f => f.name)) || "";
        if (!name) {
          ctx.ui.notify("Cancelled.", "warning");
          return;
        }
      }

      const flowFiles = getFlowFiles(projectRoot);
      const matchingFlow = flowFiles.find(f => f.name === name);

      if (!matchingFlow) {
        ctx.ui.notify(`No flow file found for "${name}".`, "warning");
        return;
      }

      // Delegate to flow-engine which has the architect infrastructure
      pi.events.emit("flows:edit-request", { flowName: name, flowPath: matchingFlow.path });
    },
  });

  // -- /flows:new — design a new flow ----------------------------------------

  pi.registerCommand("flows:new", {
    description: "Design a new flow",
    handler: async (args, ctx) => {
      let description = args?.trim() || "";

      if (!description) {
        description = await ctx.ui.input("Describe what the flow should do:", "") || "";
        if (!description) {
          ctx.ui.notify("Cancelled.", "warning");
          return;
        }
      }

      pi.events.emit("flows:new-request", { description });
    },
  });
}
