// ---------------------------------------------------------------------------
// Flow Workspace Extension
//
// Handles flow creation and editing workflows:
//   - flows:new-request — analyze conversation, design flow with architect,
//     replan loop, save/run with dashboard
//   - flows:edit-request — edit existing flow with architect + replan loop
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { createStagingDir, wipeStagingDir, promoteStagingToFinal, STAGING_AGENTS, STAGING_FLOWS } from "./staging.js";
import { join } from "node:path";
import { getModelRole } from "../provider-register.js";
import { setFlowWidget } from "../shared/flow-widget.js";

// ---- Helpers --------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/** Extract user/assistant text messages from session entries for context. */
function extractConversationContext(entries: any[]): string {
  const messages: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    if (text.trim()) {
      messages.push(`[${role}]: ${text.slice(0, 2000)}`);
    }
  }
  // Return last ~10 messages for context (don't overwhelm the compact model)
  return messages.slice(-10).join("\n\n");
}

// System prompt for slug/description generation
const SLUG_SYSTEM_PROMPT = `You generate a change slug and description from conversation context.

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation
- If the conversation clearly describes a task/feature/change, return:
  {"slug": "short-kebab-case-slug", "desc": "One sentence description of the change"}
- If the conversation is too vague or has no actionable content, return:
  {"needsMore": true}
- slug: max 50 chars, lowercase, kebab-case, no special chars
- desc: max 120 chars, imperative mood ("Add X", "Fix Y", "Implement Z")`;

/** Get architect tool definitions and spawn context from flow-engine via events */
function getArchitectSpawnContext(pi: ExtensionAPI): { tools: any[]; authStorage: any; modelRegistry: any; extraGuardFactories: any[] } {
  const toolsQuery: any = {};
  pi.events.emit("flow:get-architect-tools", toolsQuery);
  const spawnCtx: any = {};
  pi.events.emit("flow:get-spawn-context", spawnCtx);
  return {
    tools: toolsQuery.tools ?? [],
    authStorage: spawnCtx.authStorage,
    modelRegistry: spawnCtx.modelRegistry,
    extraGuardFactories: spawnCtx.extraGuardFactories ?? [],
  };
}

// ---- Flow edit handler ----------------------------------------------------

async function handleEditFlow(
  pi: ExtensionAPI,
  projectRoot: string,
  ctx: any,
  getModelRole: ((role: string) => string | undefined) | undefined,
  preselectedFlowName?: string,
  preselectedFlowPath?: string,
): Promise<void> {
  let selectedFlow: { name: string; path: string } | undefined;

  // Use preselected flow if provided
  if (preselectedFlowName && preselectedFlowPath && existsSync(preselectedFlowPath)) {
    selectedFlow = { name: preselectedFlowName, path: preselectedFlowPath };
  } else {
    // Discover available flows
    const flowFiles: { name: string; path: string }[] = [];

    const savedFlowsDir = join(projectRoot, ".pi", "flows", "flows");
    if (existsSync(savedFlowsDir)) {
      try {
        const { readdirSync, statSync } = await import("node:fs");
        for (const entry of readdirSync(savedFlowsDir)) {
          const entryPath = join(savedFlowsDir, entry);
          if (entry.endsWith(".flow.md")) {
            flowFiles.push({ name: entry.replace(".flow.md", ""), path: entryPath });
          } else {
            try {
              if (statSync(entryPath).isDirectory()) {
                for (const sub of readdirSync(entryPath)) {
                  if (sub.endsWith(".flow.md")) {
                    const name = `${entry}:${sub.replace(".flow.md", "")}`;
                    flowFiles.push({ name, path: join(entryPath, sub) });
                  }
                }
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }

    if (flowFiles.length === 0) {
      ctx.ui.notify("No flows found to edit.", "info");
      return;
    }

    const flowChoice = await ctx.ui.select(
      "Select flow to edit:",
      flowFiles.map(f => f.name),
    );
    if (!flowChoice) {
      ctx.ui.notify("Cancelled.", "warning");
      return;
    }

    selectedFlow = flowFiles.find(f => f.name === flowChoice);
    if (!selectedFlow) return;
  }

  // Read the existing flow content
  const existingContent = readFileSync(selectedFlow.path, "utf-8");

  // Ask what to change
  const modificationRequest = await ctx.ui.input("How should this flow be updated?", "");
  if (!modificationRequest) {
    ctx.ui.notify("Cancelled.", "warning");
    return;
  }

  // Load architect agent config
  let pkgRoot: string;
  let architectConfig: any;
  try {
    const { resolvePackageRoot } = await import("../flow-engine/discovery.js");
    pkgRoot = resolvePackageRoot(import.meta.url);
    const { parseAgentFile } = await import("../flow-engine/agent-parser.js");
    architectConfig = parseAgentFile(join(pkgRoot, "agents", "flow-architect.md"));
  } catch {
    ctx.ui.notify("Could not load flow-architect agent.", "error");
    return;
  }

  // Get discovered agents for source resolution
  const agentsQuery: any = {};
  pi.events.emit("flow:get-agents", agentsQuery);
  const discoveredAgentsMap: Map<string, any> = agentsQuery.agents ?? new Map();

  // Resolve agent source type: local if under .pi/, built-in otherwise
  const piLocalPrefix = join(projectRoot, ".pi");
  const resolveAgentType = (agentName: string): "built-in" | "local" => {
    const config = discoveredAgentsMap.get(agentName);
    if (config?.source && config.source.startsWith(piLocalPrefix)) return "local";
    return "built-in";
  };

  // Mount architect widget
  let architectWidget: any = null;
  let renderWidget: (() => void) | undefined;
  let overlayOpen = false;
  let architectAbort: AbortController | null = null;

  // Ctrl+O / Ctrl+X handler during architect phase
  const KEY_CTRL_O = "\x0f";
  const KEY_CTRL_X = "\x18";
  const unregisterInput = ctx.ui.onTerminalInput(async (data: string) => {
    // Ctrl+X: abort the architect agent
    if (data === KEY_CTRL_X && architectAbort) {
      architectAbort.abort();
      return { consume: true } as const;
    }
    // Ctrl+O: open detail overlay (tool calls) or flow preview overlay
    if (data === KEY_CTRL_O && architectWidget && !overlayOpen) {
      overlayOpen = true;
      try {
        if (architectWidget.hasFlowContent()) {
          // Flow exists — show flow preview
          const content = architectWidget.getFlowContent();
          if (!content) { overlayOpen = false; return { consume: true } as const; }
          const { parseFlowString } = await import("../flow-engine/flow-parser.js");
          const flowConfig = parseFlowString(content, "<preview>");
          const { createFlowPreviewOverlay } = await import("../flow-dashboard/flow-preview-overlay.js");
          await ctx.ui.custom(
            (tuiInstance: any, theme: any, _kb: any, done: (r: null) => void) => {
              return createFlowPreviewOverlay({
                flow: flowConfig,
                theme,
                tui: tuiInstance,
                done,
              });
            },
            {
              overlay: true,
              overlayOptions: {
                width: "90%",
                maxHeight: "85%",
                anchor: "center",
              },
            },
          );
        } else {
          // No flow yet — show architect detail (tool calls, messages)
          const entries = architectWidget.getEventLog?.() || [];
          if (entries.length > 0) {
            const { createAgentDetailOverlay } = await import("../flow-dashboard/agent-detail-overlay.js");
            await ctx.ui.custom(
              (tuiInstance: any, theme: any, _kb: any, done: (r: null) => void) => {
                return createAgentDetailOverlay({
                  agentName: "flow-architect",
                  status: "running",
                  summary: undefined,
                  entries,
                  theme,
                  tui: tuiInstance,
                  done,
                });
              },
              {
                overlay: true,
                overlayOptions: {
                  width: "90%",
                  maxHeight: "85%",
                  anchor: "center",
                },
              },
            );
          }
        }
      } catch { /* overlay not available */ }
      finally { overlayOpen = false; }
      return { consume: true } as const;
    }
    return undefined;
  });

  let widgetTuiRef: any = null;
  const mountWidget = async () => {
    try {
      const { createArchitectWidget } = await import("../flow-dashboard/architect-widget.js");
      architectWidget = createArchitectWidget({ resolveAgentType });
      // Wrap factory to capture TUI reference for requestRender
      const wrappedFactory = (tui: any, theme: any) => {
        widgetTuiRef = tui;
        return architectWidget.factory(tui, theme);
      };
      // setFlowWidget clears all other flow widgets automatically
      setFlowWidget(ctx.ui, "flow-architect", wrappedFactory);
      renderWidget = () => { widgetTuiRef?.requestRender(); };
      architectWidget.setUpdateCallback(renderWidget);
    } catch { /* widget not available */ }
  };
  await mountWidget();

  // Set up staging directory for architect session
  createStagingDir(projectRoot);
  pi.events.emit("flow:register-agents-dir", { dir: join(projectRoot, STAGING_AGENTS) });

  const stagingInstructions = `\n\nIMPORTANT: Write all agent files to ${STAGING_AGENTS}/ and all flow files to ${STAGING_FLOWS}/ (these are staging directories).`;
  const task = `Modify this existing flow:\n\n${existingContent}\n\nModification request: ${modificationRequest}${stagingInstructions}`;
  const templateCtx = {
    task,
    inputs: {} as Record<string, string>,
    results: {} as Record<string, any>,
    forks: {} as Record<string, any>,
  };

  const { spawnAgent } = await import("../flow-engine/execution.js");
  let choice = "";
  let flowPath = "";
  let replanNotes = "";
  const createdFiles: string[] = [];
  const allCreatedFiles = new Set<string>();

  while (true) {
    const currentTask = replanNotes
      ? `${task}\n\nReplan notes: ${replanNotes}`
      : task;

    ctx.ui.notify(
      replanNotes ? "Replanning flow..." : "Flow Architect is editing your flow...",
      "info",
    );

    architectAbort = new AbortController();
    const spawnCtx = getArchitectSpawnContext(pi);
    const result = await spawnAgent({
      agent: architectConfig,
      task: currentTask,
      templateContext: { ...templateCtx, task: currentTask },
      getModelRole: getModelRole ? (role: string) => getModelRole!(role) : undefined,
      cwd: projectRoot,
      authStorage: spawnCtx.authStorage,
      modelRegistry: spawnCtx.modelRegistry,
      extraGuardFactories: spawnCtx.extraGuardFactories,
      extraCustomTools: spawnCtx.tools,
      signal: architectAbort.signal,
      onToolCall: (toolName, input) => {
        if (architectWidget) {
          architectWidget.onToolCall(toolName, input);
          renderWidget?.();
        }
      },
      onToolResult: (toolName, output, isError) => {
        if (architectWidget) {
          architectWidget.onToolResult(toolName, output, isError);
          renderWidget?.();
        }
      },
      onAssistantText: (text) => {
        architectWidget?.onAssistantText?.(text);
      },
      onThinkingText: (text) => {
        architectWidget?.onThinkingText?.(text);
      },
    });
    architectAbort = null;

    // If aborted, treat as cancel
    if (!result.success && result.result?.summary === "Aborted by user") {
      choice = "Cancel";
      break;
    }

    flowPath = "";
    createdFiles.length = 0;

    for (const tc of result.toolCalls) {
      if (tc.toolName === "flow_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { flowPath = path; createdFiles.push(path); allCreatedFiles.add(path); }
      }
      if (tc.toolName === "agent_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { createdFiles.push(path); allCreatedFiles.add(path); }
      }
    }

    if (!flowPath) {
      // Graceful exit: show architect's summary and let user retry or cancel
      while (overlayOpen) await new Promise(r => setTimeout(r, 100));
      const summary = result.result?.summary || result.output?.slice(0, 500) || "No details available";
      const retryChoice = await ctx.ui.select(
        `Architect couldn't produce a flow:\n${summary}\n\nWhat would you like to do?`,
        ["Retry", "Cancel"],
      ) || "Cancel";
      if (retryChoice === "Retry") {
        replanNotes = await ctx.ui.input("Additional guidance for the architect:", "") || "";
        if (!replanNotes) { choice = "Cancel"; break; }
        if (architectWidget) {
          architectWidget.dispose();
          setFlowWidget(ctx.ui, "flow-architect", undefined);
        }
        await mountWidget();
        continue;
      }
      break;
    }

    // Wait for any open preview overlay to close before prompting
    while (overlayOpen) await new Promise(r => setTimeout(r, 100));

    choice = await ctx.ui.select(
      "What would you like to do?",
      ["Save", "Replan", "Cancel"],
    ) || "Cancel";

    if (choice === "Replan") {
      replanNotes = await ctx.ui.input("What should be changed?", "") || "";
      if (!replanNotes) { choice = "Cancel"; break; }
      wipeStagingDir(projectRoot);
      createStagingDir(projectRoot);
      createdFiles.length = 0;
      flowPath = "";
      if (architectWidget) {
        architectWidget.dispose();
        setFlowWidget(ctx.ui, "flow-architect", undefined);
      }
      await mountWidget();
      continue;
    }

    break;
  }

  // Dispose architect widget and unregister input handler
  unregisterInput?.();
  if (architectWidget) {
    architectWidget.dispose();
    setFlowWidget(ctx.ui, "flow-architect", undefined);
  }

  if (choice === "Cancel" || !flowPath) {
    wipeStagingDir(projectRoot);
    ctx.ui.notify("Cancelled.", "warning");
    return;
  }

  // Save: copy the edited flow back to the original location
  if (choice === "Save") {
    try {
      // Promote staging: copy agents to final, copy flow to original path
      const stagingAgentsDir = join(projectRoot, STAGING_AGENTS);
      const finalAgentsDir = join(projectRoot, ".pi", "flows", "agents");
      mkdirSync(finalAgentsDir, { recursive: true });
      if (existsSync(stagingAgentsDir)) {
        const { readdirSync } = await import("node:fs");
        for (const file of readdirSync(stagingAgentsDir)) {
          if (file.endsWith(".md")) {
            copyFileSync(join(stagingAgentsDir, file), join(finalAgentsDir, file));
          }
        }
      }
      // Copy the staged flow to the original flow's location
      if (flowPath && existsSync(flowPath)) {
        copyFileSync(flowPath, selectedFlow.path);
      }
      wipeStagingDir(projectRoot);
      pi.events.emit("flow:rediscover", {});
      ctx.ui.notify(`Flow "${selectedFlow.name}" updated.`, "info");
    } catch (err: any) {
      ctx.ui.notify(`Failed to save flow: ${err.message}`, "error");
    }
  }
}

// ---- Flow creation handler ------------------------------------------------

async function handleNewFlow(
  pi: ExtensionAPI,
  projectRoot: string,
  description: string | undefined,
  ctx: any,
  getModelRole: ((role: string) => string | undefined) | undefined,
): Promise<void> {
  // Step 1: Determine description
  let desc = description?.trim() || "";

  if (!desc) {
    // Try to generate from conversation context
    const entries = ctx.sessionManager.getEntries();
    const convoContext = extractConversationContext(entries);

    if (convoContext.length > 50) {
      ctx.ui.notify("Analyzing conversation...", "info");

      try {
        let model: any = null;
        const modelId = getModelRole?.("compact");
        if (modelId && ctx.modelRegistry) {
          const [provider, ...modelParts] = modelId.split("/");
          model = ctx.modelRegistry.find(provider, modelParts.join("/"));
        }

        if (model && ctx.modelRegistry) {
          const apiKey = await ctx.modelRegistry.getApiKey(model);
          if (apiKey) {
            const { completeSimple } = await import("@mariozechner/pi-ai");
            const response = await completeSimple(model, {
              systemPrompt: SLUG_SYSTEM_PROMPT,
              messages: [{
                role: "user" as const,
                content: [{ type: "text" as const, text: convoContext }],
                timestamp: Date.now(),
              }],
            }, { apiKey });

            const text = response.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");

            try {
              const parsed = JSON.parse(text.trim());
              if (!parsed.needsMore && parsed.desc) {
                desc = parsed.desc;
              }
            } catch {
              // JSON parse failed — fall through to ask user
            }
          }
        }
      } catch {
        // Model call failed — fall through to ask user
      }
    }

    // Fallback: ask user if we couldn't generate
    if (!desc) {
      const userDesc = await ctx.ui.input(
        "Describe what you want to build:",
        "",
      );
      if (!userDesc) {
        ctx.ui.notify("Cancelled.", "warning");
        return;
      }
      desc = userDesc;
    }
  }

  // Step 2: Load architect agent config
  let pkgRoot: string;
  let architectConfig: any;
  try {
    const { resolvePackageRoot } = await import("../flow-engine/discovery.js");
    pkgRoot = resolvePackageRoot(import.meta.url);
    const { parseAgentFile } = await import("../flow-engine/agent-parser.js");
    architectConfig = parseAgentFile(join(pkgRoot, "agents", "flow-architect.md"));
  } catch {
    ctx.ui.notify("Could not load flow-architect agent.", "error");
    return;
  }

  // Step 3: Mount architect TUI widget with agent source resolution + Ctrl+O/Ctrl+X
  const agentsQuery2: any = {};
  pi.events.emit("flow:get-agents", agentsQuery2);
  const discoveredAgentsMap2: Map<string, any> = agentsQuery2.agents ?? new Map();

  const piLocalPrefix2 = join(projectRoot, ".pi");
  const resolveAgentType2 = (agentName: string): "built-in" | "local" => {
    const config = discoveredAgentsMap2.get(agentName);
    if (config?.source && config.source.startsWith(piLocalPrefix2)) return "local";
    return "built-in";
  };

  let architectWidget: any = null;
  let renderWidget: (() => void) | undefined;
  let overlayOpen2 = false;
  let architectAbort2: AbortController | null = null;

  const KEY_CTRL_O_2 = "\x0f";
  const KEY_CTRL_X_2 = "\x18";
  const unregisterInput2 = ctx.ui.onTerminalInput(async (data: string) => {
    if (data === KEY_CTRL_X_2 && architectAbort2) {
      architectAbort2.abort();
      return { consume: true } as const;
    }
    if (data === KEY_CTRL_O_2 && architectWidget && !overlayOpen2) {
      overlayOpen2 = true;
      try {
        if (architectWidget.hasFlowContent()) {
          const content = architectWidget.getFlowContent();
          if (!content) { overlayOpen2 = false; return { consume: true } as const; }
          const { parseFlowString } = await import("../flow-engine/flow-parser.js");
          const flowConfig = parseFlowString(content, "<preview>");
          const { createFlowPreviewOverlay } = await import("../flow-dashboard/flow-preview-overlay.js");
          await ctx.ui.custom(
            (tuiInstance: any, theme: any, _kb: any, done: (r: null) => void) => {
              return createFlowPreviewOverlay({
                flow: flowConfig,
                theme,
                tui: tuiInstance,
                done,
              });
            },
            {
              overlay: true,
              overlayOptions: {
                width: "90%",
                maxHeight: "85%",
                anchor: "center",
              },
            },
          );
        } else {
          const entries = architectWidget.getEventLog?.() || [];
          if (entries.length > 0) {
            const { createAgentDetailOverlay } = await import("../flow-dashboard/agent-detail-overlay.js");
            await ctx.ui.custom(
              (tuiInstance: any, theme: any, _kb: any, done: (r: null) => void) => {
                return createAgentDetailOverlay({
                  agentName: "flow-architect",
                  status: "running",
                  summary: undefined,
                  entries,
                  theme,
                  tui: tuiInstance,
                  done,
                });
              },
              {
                overlay: true,
                overlayOptions: {
                  width: "90%",
                  maxHeight: "85%",
                  anchor: "center",
                },
              },
            );
          }
        }
      } catch { /* overlay not available */ }
      finally { overlayOpen2 = false; }
      return { consume: true } as const;
    }
    return undefined;
  });

  let widgetTuiRef2: any = null;
  const mountWidget = async () => {
    try {
      const { createArchitectWidget } = await import("../flow-dashboard/architect-widget.js");
      architectWidget = createArchitectWidget({ resolveAgentType: resolveAgentType2 });
      const wrappedFactory = (tui: any, theme: any) => {
        widgetTuiRef2 = tui;
        return architectWidget.factory(tui, theme);
      };
      // setFlowWidget clears all other flow widgets automatically
      setFlowWidget(ctx.ui, "flow-architect", wrappedFactory);
      renderWidget = () => { widgetTuiRef2?.requestRender(); };
      architectWidget.setUpdateCallback(renderWidget);
    } catch {
      // Widget not available — continue without visual feedback
    }
  };
  await mountWidget();

  // Step 4: Spawn architect subagent (with replan loop)
  // Set up staging directory and register for discovery
  createStagingDir(projectRoot);
  pi.events.emit("flow:register-agents-dir", { dir: join(projectRoot, STAGING_AGENTS) });

  const templateCtx = {
    task: desc,
    inputs: {} as Record<string, string>,
    results: {} as Record<string, any>,
    forks: {} as Record<string, any>,
  };

  const { spawnAgent } = await import("../flow-engine/execution.js");
  let choice = "";
  let flowPath = "";
  let replanNotes = "";
  const createdFiles: string[] = [];
  const allCreatedFiles = new Set<string>();

  while (true) {
    const stagingInstructions = `\n\nIMPORTANT: Write all agent files to ${STAGING_AGENTS}/ and all flow files to ${STAGING_FLOWS}/ (these are staging directories).`;
    const task = replanNotes
      ? `${desc}\n\nReplan notes: ${replanNotes}${stagingInstructions}`
      : `${desc}${stagingInstructions}`;

    ctx.ui.notify(
      replanNotes ? "Replanning flow..." : "Flow Architect is designing your flow...",
      "info",
    );

    architectAbort2 = new AbortController();
    const spawnCtx2 = getArchitectSpawnContext(pi);
    const result = await spawnAgent({
      agent: architectConfig,
      task,
      templateContext: { ...templateCtx, task },
      getModelRole: getModelRole ? (role: string) => getModelRole!(role) : undefined,
      cwd: projectRoot,
      authStorage: spawnCtx2.authStorage,
      modelRegistry: spawnCtx2.modelRegistry,
      extraGuardFactories: spawnCtx2.extraGuardFactories,
      extraCustomTools: spawnCtx2.tools,
      signal: architectAbort2.signal,
      onToolCall: (toolName, input) => {
        if (architectWidget) {
          architectWidget.onToolCall(toolName, input);
          renderWidget?.();
        }
      },
      onToolResult: (toolName, output, isError) => {
        if (architectWidget) {
          architectWidget.onToolResult(toolName, output, isError);
          renderWidget?.();
        }
      },
      onAssistantText: (text) => {
        architectWidget?.onAssistantText?.(text);
      },
      onThinkingText: (text) => {
        architectWidget?.onThinkingText?.(text);
      },
    });
    architectAbort2 = null;

    // If aborted, treat as cancel
    if (!result.success && result.result?.summary === "Aborted by user") {
      choice = "Cancel";
      break;
    }

    // Extract flow path and created files from tool calls
    flowPath = "";
    createdFiles.length = 0;

    for (const tc of result.toolCalls) {
      if (tc.toolName === "flow_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { flowPath = path; createdFiles.push(path); allCreatedFiles.add(path); }
      }
      if (tc.toolName === "agent_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { createdFiles.push(path); allCreatedFiles.add(path); }
      }
    }

    if (!flowPath) {
      // Graceful exit: show architect's summary and let user retry or cancel
      while (overlayOpen2) await new Promise(r => setTimeout(r, 100));
      const summary = result.result?.summary || result.output?.slice(0, 500) || "No details available";
      const retryChoice = await ctx.ui.select(
        `Architect couldn't produce a flow:\n${summary}\n\nWhat would you like to do?`,
        ["Retry", "Cancel"],
      ) || "Cancel";
      if (retryChoice === "Retry") {
        replanNotes = await ctx.ui.input("Additional guidance for the architect:", "") || "";
        if (!replanNotes) { choice = "Cancel"; break; }
        if (architectWidget) {
          architectWidget.dispose();
          setFlowWidget(ctx.ui, "flow-architect", undefined);
        }
        await mountWidget();
        continue;
      }
      break;
    }

    // Wait for any open preview overlay to close before prompting
    while (overlayOpen2) await new Promise(r => setTimeout(r, 100));

    // Present choice to user — flow details are visible in the widget above
    choice = await ctx.ui.select(
      "What would you like to do?",
      ["Run", "Save & Run", "Replan", "Cancel"],
    ) || "Cancel";

    if (choice === "Replan") {
      replanNotes = await ctx.ui.input("What should be changed?", "") || "";
      if (!replanNotes) {
        choice = "Cancel";
        break;
      }
      // Wipe staging and recreate for fresh iteration
      wipeStagingDir(projectRoot);
      createStagingDir(projectRoot);
      createdFiles.length = 0;
      flowPath = "";
      // Reset widget for new design cycle
      if (architectWidget) {
        architectWidget.dispose();
        setFlowWidget(ctx.ui, "flow-architect", undefined);
      }
      await mountWidget();
      continue;
    }

    break; // Run, Save & Run, or Cancel
  }

  // Dispose architect widget and unregister input handler
  unregisterInput2?.();
  if (architectWidget) {
    architectWidget.dispose();
    setFlowWidget(ctx.ui, "flow-architect", undefined);
  }

  if (choice === "Cancel") {
    wipeStagingDir(projectRoot);
    ctx.ui.notify("Cancelled.", "warning");
    return;
  }

  if (!flowPath) {
    // Architect failed — error diagnostic already shown
    return;
  }

  // Step 5: Handle "Save & Run" — promote staging to final locations
  if (choice === "Save & Run") {
    const defaultName = slugify(desc);
    const flowName = await ctx.ui.input(
      "Name this flow (available as /custom:<name>):",
      defaultName,
    );

    if (flowName) {
      const safeName = slugify(flowName);
      const finalFlowPath = promoteStagingToFinal(projectRoot, safeName);
      flowPath = finalFlowPath || flowPath;

      // Re-discover so the saved flow registers as a command immediately
      pi.events.emit("flow:rediscover", {});

      ctx.ui.notify(
        `Flow saved as "${safeName}" — available as /custom:${safeName}`,
        "info",
      );
    } else {
      // User cancelled naming — fall back to "Run" behavior (no persist, cleanup after)
      choice = "Run";
    }
  }

  // Step 6: Execute the designed flow via the flow manager (proper lifecycle)
  setFlowWidget(ctx.ui, "flow-architect", undefined);

  try {
    // Re-discover to pick up custom agents written by architect
    pi.events.emit("flow:rediscover", {});

    const { parseFlowFile } = await import("../flow-engine/flow-parser.js");
    const flowConfig = parseFlowFile(flowPath);

    ctx.ui.notify(`Running flow: "${flowConfig.name}"...`, "info");

    // Register staging flows dir temporarily so the flow can be discovered
    pi.events.emit("flow:register-flows-dir", { dir: join(projectRoot, STAGING_FLOWS) });
    // Re-discover again to pick up the staged flow
    pi.events.emit("flow:rediscover", {});

    // Run via flow:run event — uses flowManager with proper dashboard, callbacks, cleanup
    pi.events.emit("flow:run", { flowName: flowConfig.name, ctx });
  } catch (err: any) {
    ctx.ui.notify(`Flow execution failed: ${err.message}`, "error");
  }
}

// ---- Extension activation -------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const projectRoot = process.cwd();

  // getModelRole is imported at top level — shared module instance via single entry point.

  // Track latest ctx for event handlers
  let lastCtx: any = null;
  pi.on("session_start", (_event, ctx) => { lastCtx = ctx; });

  // flows:new-request — triggered by /flows:new or /flows → "New flow"
  pi.events.on("flows:new-request", async (data: any) => {
    if (!lastCtx) return;
    const description = (data as any)?.description || "";
    await handleNewFlow(pi, projectRoot, description, lastCtx, getModelRole);
  });

  // flows:edit-request — triggered by /flows:edit or /flows <name> → Edit
  pi.events.on("flows:edit-request", async (data: any) => {
    if (!lastCtx) return;
    const { flowName, flowPath } = data as { flowName: string; flowPath: string };
    if (flowPath && !existsSync(flowPath)) {
      lastCtx.ui.notify("Flow file not found.", "error");
      return;
    }
    await handleEditFlow(pi, projectRoot, lastCtx, getModelRole, flowName, flowPath);
  });
}
