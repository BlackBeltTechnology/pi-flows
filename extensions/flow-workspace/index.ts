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
import { join } from "node:path";
import { getModelRole } from "../provider-register.js";

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
    // Ctrl+O: open flow preview overlay
    if (data === KEY_CTRL_O && architectWidget?.hasFlowContent?.() && !overlayOpen) {
      overlayOpen = true;
      try {
        const content = architectWidget.getFlowContent();
        if (!content) return { consume: true } as const;
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
      } catch { /* overlay not available */ }
      finally { overlayOpen = false; }
      return { consume: true } as const;
    }
    return undefined;
  });

  const mountWidget = async () => {
    try {
      const { createArchitectWidget } = await import("../flow-dashboard/architect-widget.js");
      architectWidget = createArchitectWidget({ resolveAgentType });
      renderWidget = () => {
        ctx.ui.setWidget("flow-architect", architectWidget.factory, { placement: "aboveEditor" });
      };
      architectWidget.setUpdateCallback(renderWidget);
      renderWidget();
    } catch { /* widget not available */ }
  };
  await mountWidget();

  const task = `Modify this existing flow:\n\n${existingContent}\n\nModification request: ${modificationRequest}`;
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
          ctx.ui.setWidget("flow-architect", undefined);
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
      if (architectWidget) {
        architectWidget.dispose();
        ctx.ui.setWidget("flow-architect", undefined);
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
    ctx.ui.setWidget("flow-architect", undefined);
  }

  if (choice === "Cancel" || !flowPath) {
    for (const f of allCreatedFiles) {
      try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ }
    }
    ctx.ui.notify("Cancelled.", "warning");
    return;
  }

  // Save: copy the edited flow back to the original location
  if (choice === "Save") {
    try {
      copyFileSync(flowPath, selectedFlow.path);
      // Clean up all temp files (current iteration + orphans from previous iterations)
      for (const f of allCreatedFiles) {
        if (f !== selectedFlow.path) {
          try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ }
        }
      }
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
    if (data === KEY_CTRL_O_2 && architectWidget?.hasFlowContent?.() && !overlayOpen2) {
      overlayOpen2 = true;
      try {
        const content = architectWidget.getFlowContent();
        if (!content) return { consume: true } as const;
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
      } catch { /* overlay not available */ }
      finally { overlayOpen2 = false; }
      return { consume: true } as const;
    }
    return undefined;
  });

  const mountWidget = async () => {
    try {
      const { createArchitectWidget } = await import("../flow-dashboard/architect-widget.js");
      architectWidget = createArchitectWidget({ resolveAgentType: resolveAgentType2 });
      renderWidget = () => {
        ctx.ui.setWidget("flow-architect", architectWidget.factory, { placement: "aboveEditor" });
      };
      architectWidget.setUpdateCallback(renderWidget);
      renderWidget();
    } catch {
      // Widget not available — continue without visual feedback
    }
  };
  await mountWidget();

  // Step 4: Spawn architect subagent (with replan loop)
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
    const task = replanNotes
      ? `${desc}\n\nReplan notes: ${replanNotes}`
      : desc;

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
          ctx.ui.setWidget("flow-architect", undefined);
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
      // Reset widget for new design cycle
      if (architectWidget) {
        architectWidget.dispose();
        ctx.ui.setWidget("flow-architect", undefined);
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
    ctx.ui.setWidget("flow-architect", undefined);
  }

  if (choice === "Cancel") {
    // Cleanup all created files on cancel (including orphans from previous replan iterations)
    for (const f of allCreatedFiles) {
      try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ }
    }
    ctx.ui.notify("Cancelled.", "warning");
    return;
  }

  if (!flowPath) {
    // Architect failed — error diagnostic already shown
    return;
  }

  // Step 5: Handle "Save & Run" — ask for name, persist to .pi/flows/
  if (choice === "Save & Run") {
    const defaultName = slugify(desc);
    const flowName = await ctx.ui.input(
      "Name this flow (available as /custom:<name>):",
      defaultName,
    );

    if (flowName) {
      const safeName = slugify(flowName);
      const piFlowsDir = join(projectRoot, ".pi", "flows", "flows", "custom");
      const piAgentsDir = join(projectRoot, ".pi", "flows", "agents");

      // Ensure directories exist
      mkdirSync(piFlowsDir, { recursive: true });
      mkdirSync(piAgentsDir, { recursive: true });

      // Copy flow file
      const destFlowPath = join(piFlowsDir, `${safeName}.flow.md`);
      copyFileSync(flowPath, destFlowPath);

      // Copy custom agent files from final iteration
      for (const f of createdFiles) {
        if (f !== flowPath && existsSync(f)) {
          const agentFileName = f.split("/").pop() || "";
          if (agentFileName) {
            copyFileSync(f, join(piAgentsDir, agentFileName));
          }
        }
      }

      // Clean up all temp files (including orphans from previous replan iterations)
      for (const f of allCreatedFiles) {
        try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ }
      }

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

  // Step 6: Execute the designed flow
  try {
    // Re-discover to pick up custom agents written by architect
    pi.events.emit("flow:rediscover", {});

    const { parseFlowFile } = await import("../flow-engine/flow-parser.js");
    const flowConfig = parseFlowFile(flowPath);
    const { runFlow } = await import("../flow-engine/flow-execution.js");
    const { findSkillDir } = await import("../flow-engine/tools/skill-read.js");

    // Retrieve agent discovery state via events
    const agentsQuery: any = {};
    pi.events.emit("flow:get-agents", agentsQuery);
    const discoveredAgents: Map<string, any> = agentsQuery.agents ?? new Map();

    // Wire up flow dashboard
    let dashboard: any = null;
    let renderDashboard: (() => void) | undefined;
    try {
      const { AgentDashboard, resolveWorkflow } = await import("../flow-dashboard/index.js");
      const resolved = resolveWorkflow(flowConfig.name);

      // Collect agent configs and deps for the dashboard
      const agentConfigs: any[] = [];
      const agentDeps = new Map<string, string[]>();
      for (const step of flowConfig.steps) {
        if (step.stepType === "agent") {
          const cfg = discoveredAgents.get(step.agent);
          if (cfg) agentConfigs.push(cfg);
          if (step.blockedBy?.length) agentDeps.set(step.agent, step.blockedBy);
        }
      }

      if (resolved) {
        dashboard = new AgentDashboard(resolved.workflow, resolved.stageIndex, undefined);
      } else {
        // No workflow definition — create a basic dashboard
        dashboard = new AgentDashboard(
          { id: flowConfig.name, stages: [{ name: flowConfig.name, flows: [flowConfig.name] }] },
          0,
          undefined,
        );
      }
      dashboard.preloadAgents(agentConfigs, agentDeps);

      // Wire via event — sets activeDashboard/dashboardVisible in flow-engine
      const wireData: any = { dashboard, ui: ctx.ui };
      pi.events.emit("flow:wire-dashboard", wireData);
      renderDashboard = wireData.renderCallback;
      if (renderDashboard) renderDashboard();
    } catch { /* flow-dashboard not available, continue without */ }

    ctx.ui.notify(`Running flow: "${flowConfig.name}"...`, "info");

    const flowResult = await runFlow({
      flow: flowConfig,
      task: desc,
      cwd: projectRoot,
      getModelRole: getModelRole ? (role: string) => getModelRole!(role) : undefined,
      getAgent: (name: string) => discoveredAgents.get(name),
      askUser: async (question, type, options, extra) => {
        if (extra?.multiSelect && options) {
          const selected: string[] = [];
          for (const opt of options) {
            const yes = await ctx.ui.confirm(`${question}\n  Include "${opt}"?`, "");
            if (yes) selected.push(opt);
          }
          return { answer: selected as any };
        }
        if (type === "select" && options) {
          const answer = await ctx.ui.select(question, options);
          return { answer: answer || options[0] };
        }
        if (type === "confirm") {
          const answer = await ctx.ui.confirm(question, "");
          return { answer: answer ? "yes" : "no" };
        }
        const answer = await ctx.ui.input(question, "");
        return { answer: answer || "" };
      },
      onAgentStarted: dashboard ? (agentName: string) => {
        const config = discoveredAgents.get(agentName);
        dashboard.onAgentStarted(agentName, config);
        renderDashboard!();
      } : undefined,
      onAgentComplete: dashboard ? (agentName: string, _stepId: string, result: any) => {
        dashboard.onAgentComplete(agentName, result);
        renderDashboard!();
      } : undefined,
      onToolCall: (agentName: string, toolName: string, input: any) => {
        pi.events.emit("flow:subagent-tool-call", { agentName, toolName, input });
        if (dashboard) { dashboard.onToolCall(agentName, toolName, input); renderDashboard!(); }
      },
      onToolResult: (agentName: string, toolName: string, output: any, isError?: boolean) => {
        pi.events.emit("flow:subagent-tool-result", { agentName, toolName, output, isError });
        if (dashboard) { dashboard.onToolResult(agentName, toolName, output); renderDashboard!(); }
      },
      getSkillContent: (skillName: string) => {
        const dir = findSkillDir(pkgRoot, skillName);
        if (!dir) return undefined;
        try { return readFileSync(join(dir, "SKILL.md"), "utf-8"); } catch { return undefined; }
      },
    });

    // Emit flow:complete to trigger summary widget
    pi.events.emit("flow:complete", flowResult);

    // Cleanup dashboard
    if (dashboard) {
      pi.events.emit("flow:unwire-dashboard", {});
      dashboard.dispose();
    }

    // Cleanup for "Run" mode — delete all temp artifacts (including orphans from previous replan iterations)
    if (choice === "Run") {
      for (const f of allCreatedFiles) {
        try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ }
      }
    }

    ctx.ui.notify(`Flow "${flowConfig.name}" complete.`, "info");
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
