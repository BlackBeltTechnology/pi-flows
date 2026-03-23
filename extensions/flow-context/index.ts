// ---------------------------------------------------------------------------
// Flow Context Extension
//
// Provides flow result management and context injection:
//   - #flows:<name> inline autocomplete + input transform
//   - /flows <name> — action menu (inject / edit / delete)
//   - /flows:delete <name> — delete a flow result + flow file
// ---------------------------------------------------------------------------

import { CustomEditor, DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteItem } from "@mariozechner/pi-tui";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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

  // Saved flows
  const savedFlowsDir = join(projectRoot, ".pi", "flows", "flows");
  if (existsSync(savedFlowsDir)) {
    try {
      for (const f of readdirSync(savedFlowsDir)) {
        if (f.endsWith(".flow.md")) {
          flowFiles.push({ name: f.replace(".flow.md", ""), path: join(savedFlowsDir, f) });
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

// -- Custom editor with #flows: autocomplete --------------------------------

function wrapProvider(provider: AutocompleteProvider, resultsDir: string): AutocompleteProvider {
  return {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
      const currentLine = lines[cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);

      // Check for #flows: prefix
      const match = textBeforeCursor.match(/#flows:([\w-]*)$/);
      if (match) {
        const prefix = match[1];
        const names = getFlowResultNames(resultsDir);
        const filtered = prefix
          ? names.filter(n => n.startsWith(prefix) || n.includes(prefix))
          : names;

        if (filtered.length > 0) {
          return {
            items: filtered.map(name => ({
              value: `#flows:${name}`,
              label: name,
              description: "Flow result",
            })),
            prefix: match[0],
          };
        }
        return null;
      }

      // Delegate to original provider
      return provider.getSuggestions(lines, cursorLine, cursorCol);
    },

    applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ) {
      // Handle #flows: completions ourselves
      if (prefix.startsWith("#flows:")) {
        const currentLine = lines[cursorLine] || "";
        const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const newLine = beforePrefix + item.value + " " + afterCursor;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + 1,
        };
      }

      // Delegate to original provider
      return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
  };
}

class FlowsEditor extends CustomEditor {
  private resultsDir: string;

  constructor(tui: any, theme: any, keybindings: any, resultsDir: string) {
    super(tui, theme, keybindings);
    this.resultsDir = resultsDir;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider(wrapProvider(provider, this.resultsDir));
  }
}

// -- Delete logic -----------------------------------------------------------

function deleteFlow(
  pi: ExtensionAPI,
  projectRoot: string,
  flowName: string,
  flowPath: string,
  ctx: any,
): void {
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
    ctx.ui.notify(`Failed to delete flow: ${err.message}`, "error");
    return;
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

  // Re-discover to unregister the deleted flow's command
  pi.events.emit("flow:rediscover", {});

  ctx.ui.notify(`Flow "${flowName}" deleted.`, "info");
}

// -- Extension entry point --------------------------------------------------

export default function activate(pi: ExtensionAPI) {
  const projectRoot = process.cwd();
  const resultsDir = join(projectRoot, ".pi", "flows", "results");


  // -- Mount custom editor with #flows: autocomplete --------------------------

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) =>
      new FlowsEditor(tui, theme, kb, resultsDir),
    );
  });

  // -- #flows:<name> input transform ----------------------------------------

  pi.on("input", async (event) => {
    const pattern = /#flows:([\w-]+)/g;
    let text = event.text;
    let matched = false;

    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) {
      return { action: "continue" as const };
    }

    for (const match of matches) {
      const name = match[1];
      const summaryPath = join(resultsDir, `${name}.md`);

      if (existsSync(summaryPath)) {
        try {
          const content = readFileSync(summaryPath, "utf-8");
          text = text.replace(
            match[0],
            `\n--- Flow Result: ${name} ---\n${content}\n--- End Flow Result ---\n`,
          );
          matched = true;
        } catch {
          // File read failed — leave token as-is
        }
      }
    }

    if (matched) {
      return { action: "transform" as const, text };
    }
    return { action: "continue" as const };
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
            `Available flows:\n${allNames.map(f => `  • ${f}`).join("\n")}\n\nUse /flows <name> for actions, or #flows:<name> inline.`,
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
        try {
          const content = readFileSync(join(resultsDir, `${name}.md`), "utf-8");
          pi.sendMessage({
            customType: "flow-context",
            content: `--- Flow Result: ${name} ---\n${content}\n--- End Flow Result ---`,
            display: true,
          });
        } catch (err: any) {
          ctx.ui.notify(`Failed to read flow result: ${err.message}`, "error");
        }
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
          deleteFlow(pi, projectRoot, name, matchingFlow.path, ctx);
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
        deleteFlow(pi, projectRoot, name, matchingFlow.path, ctx);
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
