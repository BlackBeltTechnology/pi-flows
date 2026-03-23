import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
} from "./types.js";
import { discoverAll, resolvePackageRoot } from "./discovery.js";
import { registerSubagentTool } from "./tool.js";
import { registerAskUserTool } from "./tools/ask-user.js";
import {
  registerSkillReadTool,
  registerExtraSkillsDir,
  findSkillDir,
} from "./tools/skill-read.js";
import { registerAgentCatalogTool } from "./tools/agent-catalog.js";
import { registerAgentValidateTool } from "./tools/agent-validate.js";
import { registerAgentWriteTool } from "./tools/agent-write.js";
import { registerFlowValidateTool } from "./tools/flow-validate.js";
import { registerFlowWriteTool } from "./tools/flow-write.js";
import { registerFlowPreviewTool } from "./tools/flow-preview.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  moveUp,
  moveDown,
  toggleExpand,
  computeExpandedContentLines,
} from "../flow-dashboard/detail-view.js";
import { GridComponent } from "../flow-dashboard/grid-component.js";

// Re-export public API
export type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
  TemplateContext,
  SubagentEvent,
  ArchitectMeta,
  CardConfig,
} from "./types.js";
export { spawnAgent, expandTemplateVariables } from "./execution.js";
export { runFlow } from "./flow-execution.js";
export type { FlowRunOptions, FlowContext } from "./flow-execution.js";
export { discoverAll, resolvePackageRoot } from "./discovery.js";
export { resolveModel } from "./model-roles.js";
export { parseResult, hasArtifactElement } from "./result-parser.js";
export { parseAgentFile, parseAgentString } from "./agent-parser.js";
export { parseFlowFile, parseFlowString } from "./flow-parser.js";

let agents = new Map<string, AgentConfig>();
let flows = new Map<string, FlowConfig>();
let packageRoot = "";
const extraAgentsDirs: string[] = [];
const extraFlowsDirs: string[] = [];

/** Collect all agent names referenced by a flow (agent steps). */
export function extractAgentNames(flow: FlowConfig): string[] {
  const names: string[] = [];
  for (const step of flow.steps) {
    if (step.stepType === "agent") names.push(step.agent);
  }
  return [...new Set(names)];
}

export function getDiscoveredAgents(): Map<string, AgentConfig> {
  return agents;
}
export function getDiscoveredFlows(): Map<string, FlowConfig> {
  return flows;
}

export function init(pkgRoot: string, projectRoot: string): void {
  packageRoot = pkgRoot;
  const result = discoverAll(
    pkgRoot,
    projectRoot,
    extraAgentsDirs,
    extraFlowsDirs,
  );
  agents = result.agents;
  flows = result.flows;
}

// ---- Gate registry ---------------------------------------------------------

interface GateEntry {
  name: string;
  check: () => boolean;
  flows: string[]; // glob patterns for flow names this gate applies to
  message: string;
}

const gates: GateEntry[] = [];

function checkGate(flowName: string): string | null {
  for (const gate of gates) {
    const matches = gate.flows.some((pattern) => {
      if (pattern.endsWith("*")) {
        return flowName.startsWith(pattern.slice(0, -1));
      }
      return flowName === pattern;
    });
    if (matches && !gate.check()) {
      return gate.message;
    }
  }
  return null;
}

// ---- Extension activation --------------------------------------------------

export default function activate(pi: ExtensionAPI) {
  const pkgRoot = resolvePackageRoot(import.meta.url);
  const projectRoot = process.cwd();
  packageRoot = pkgRoot;

  // Initial discovery
  init(pkgRoot, projectRoot);

  const guardExtPath = join(pkgRoot, "extensions", "flow-engine", "guard.ts");

  let getModelRole: ((role: string) => string | undefined) | undefined;

  // Try to import getModelRole from provider-register
  try {
    const providerPath = join(pkgRoot, "extensions", "provider-register.ts");
    if (existsSync(providerPath)) {
      import(providerPath)
        .then((mod) => {
          if (mod.getModelRole) getModelRole = mod.getModelRole;
        })
        .catch(() => {
          /* ignore */
        });
    }
  } catch {
    /* ignore */
  }

  // ── Interactive state ──
  let dashboardVisible = false;
  let summaryVisible = false;
  let activeDashboard: any = null;
  let lastFlowResult: FlowResult | null = null;
  let lastToolHistory: Map<string, any[]> | null = null;
  let uiCtx: any = null;
  let tui: any = null; // TUI reference for requestRender
  let getSummaryStateRef: (() => any) | null = null;

  pi.on("session_start", (_event: any, ctx: any) => {
    uiCtx = ctx.ui;
    if (ctx.hasUI) {
      // Print help once at session start, not as a persistent widget
      const lines = [
        "  /flows              Manage flows (new, edit, delete)",
        "  /flows:new          Design & run a new flow",
        "  /flows:edit         Edit an existing flow",
        "  /flows:delete       Delete a flow",
        "  #flows:<name>       Inject flow result inline",
        "  /provider           Manage LLM providers",
        "  /roles              Assign model roles",
        "",
      ];
      pi.sendMessage({
        customType: "pi-flows-help",
        content: lines.join("\n"),
        display: true,
      });
    }
    ctx.ui.onTerminalInput((data: string) => {
      return handleDashboardInput(data);
    });
  });

  // Listen for flow:complete to track summary visibility and store result
  pi.events?.on("flow:complete", async (data: unknown) => {
    lastFlowResult = data as FlowResult;
    summaryVisible = true;
    // Share tool history with summary widget
    pi.events.emit("flow:set-summary-tool-history", {
      toolHistory: lastToolHistory,
    });
    // Lazy-load getSummaryState for input routing
    if (!getSummaryStateRef) {
      try {
        const mod = await import("../flow-summary/index.js");
        getSummaryStateRef = mod.getSummaryState;
      } catch {
        /* flow-summary not available */
      }
    }
  });

  // ── Key constants ──
  const KEY_CTRL_O = "\x0f";
  const KEY_ESC = "\x1b";
  const KEY_UP = "\x1b[A";
  const KEY_DOWN = "\x1b[B";
  const KEY_RIGHT = "\x1b[C";
  const KEY_LEFT = "\x1b[D";
  const KEY_ENTER = "\r";
  const KEY_BACKSPACE_1 = "\x7f";
  const KEY_BACKSPACE_2 = "\b";
  const KEY_CTRL_T = "\x14";

  function requestRender() {
    tui?.requestRender();
  }

  function handleDashboardInput(data: string): { consume: true } | undefined {
    // ── Dashboard widget active (during flow) ──
    if (dashboardVisible && activeDashboard) {
      const db = activeDashboard;
      const mode = db.mode;

      if (mode === "passive") {
        if (data === KEY_CTRL_O) {
          db.mode = "navigate";
          db.selectedCardIndex = 0;
          requestRender();
          return { consume: true };
        }
        return undefined;
      }

      if (mode === "navigate") {
        if (data === KEY_CTRL_O || data === KEY_ESC) {
          db.mode = "passive";
          requestRender();
          return { consume: true };
        }
        if (
          data === KEY_UP ||
          data === KEY_DOWN ||
          data === KEY_LEFT ||
          data === KEY_RIGHT
        ) {
          navigateCard(db, data);
          requestRender();
          return { consume: true };
        }
        if (data === KEY_ENTER) {
          const names = db.getAgentNames();
          const name = names[db.selectedCardIndex];
          if (name) {
            db.detailAgentName = name;
            db.detailScroll = {
              scrollOffset: 0,
              selectedIndex: 0,
              expandedIndex: -1,
              contentScroll: 0,
            };
            db.mode = "detail";
            requestRender();
          }
          return { consume: true };
        }
        return undefined;
      }

      if (mode === "detail") {
        if (data === KEY_ESC) {
          db.mode = "passive";
          requestRender();
          return { consume: true };
        }
        if (data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
          db.mode = "navigate";
          requestRender();
          return { consume: true };
        }
        if (data === KEY_CTRL_T) {
          db.showThinking = !db.showThinking;
          requestRender();
          return { consume: true };
        }
        if (data === KEY_UP) {
          moveUp(db.detailScroll);
          requestRender();
          return { consume: true };
        }
        if (data === KEY_DOWN) {
          const entries = db.getEventLog(db.detailAgentName);
          const termWidth = tui?.terminal?.columns ?? 120;
          const termRows = tui?.terminal?.rows ?? 40;
          const viewportHeight = Math.max(20, termRows - 8) - 6; // subtract header+footer
          const totalLines = computeExpandedContentLines(
            entries,
            db.detailScroll,
            termWidth,
            db.showThinking,
          );
          moveDown(db.detailScroll, entries.length, totalLines, viewportHeight);
          requestRender();
          return { consume: true };
        }
        if (data === KEY_ENTER) {
          toggleExpand(db.detailScroll);
          requestRender();
          return { consume: true };
        }
        return undefined;
      }
    }

    // ── Summary widget active (post-flow) ──
    if (summaryVisible) {
      return handleSummaryInput(data);
    }

    return undefined;
  }

  function handleSummaryInput(data: string): { consume: true } | undefined {
    let summaryState: any = null;
    try {
      summaryState = getSummaryStateRef?.();
    } catch {
      /* flow-summary not available */
    }
    if (!summaryState) return undefined;

    const mode = summaryState.mode;

    if (mode === "summary") {
      if (data === KEY_CTRL_O) {
        summaryState.mode = "navigate";
        summaryState.selectedIndex = 0;
        requestRender();
        return { consume: true };
      }
      return undefined;
    }

    if (mode === "navigate") {
      if (data === KEY_CTRL_O || data === KEY_ESC) {
        summaryState.mode = "summary";
        requestRender();
        return { consume: true };
      }
      if (data === KEY_UP) {
        if (summaryState.selectedIndex > 0) summaryState.selectedIndex--;
        requestRender();
        return { consume: true };
      }
      if (data === KEY_DOWN) {
        if (summaryState.selectedIndex < summaryState.agentNames.length - 1)
          summaryState.selectedIndex++;
        requestRender();
        return { consume: true };
      }
      if (data === KEY_ENTER) {
        const name = summaryState.agentNames[summaryState.selectedIndex];
        if (name) {
          summaryState.detailAgentName = name;
          summaryState.detailScroll = {
            scrollOffset: 0,
            selectedIndex: 0,
            expandedIndex: -1,
            contentScroll: 0,
          };
          summaryState.mode = "detail";
          requestRender();
        }
        return { consume: true };
      }
      return undefined;
    }

    if (mode === "detail") {
      if (data === KEY_ESC) {
        summaryState.mode = "summary";
        requestRender();
        return { consume: true };
      }
      if (data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
        summaryState.mode = "navigate";
        requestRender();
        return { consume: true };
      }
      if (data === KEY_CTRL_T) {
        summaryState.showThinking = !summaryState.showThinking;
        requestRender();
        return { consume: true };
      }
      if (data === KEY_UP) {
        moveUp(summaryState.detailScroll);
        requestRender();
        return { consume: true };
      }
      if (data === KEY_DOWN) {
        const entries =
          lastToolHistory?.get(summaryState.detailAgentName) || [];
        const termWidth = tui?.terminal?.columns ?? 120;
        const termRows = tui?.terminal?.rows ?? 40;
        const viewportHeight = Math.max(20, termRows - 8) - 6;
        const totalLines = computeExpandedContentLines(
          entries,
          summaryState.detailScroll,
          termWidth,
          summaryState.showThinking ?? true,
        );
        moveDown(
          summaryState.detailScroll,
          entries.length,
          totalLines,
          viewportHeight,
        );
        requestRender();
        return { consume: true };
      }
      if (data === KEY_ENTER) {
        toggleExpand(summaryState.detailScroll);
        requestRender();
        return { consume: true };
      }
      return undefined;
    }

    return undefined;
  }

  // ── Grid navigation math ──
  function navigateCard(db: any, key: string) {
    const names = db.getAgentNames();
    const count = names.length;
    if (count === 0) return;

    const termWidth = tui?.terminal?.columns ?? 120;
    const cols = GridComponent.computeCols(count, termWidth);
    let idx = db.selectedCardIndex;

    if (key === KEY_LEFT) {
      idx = Math.max(0, idx - 1);
    } else if (key === KEY_RIGHT) {
      idx = Math.min(count - 1, idx + 1);
    } else if (key === KEY_UP) {
      idx = Math.max(0, idx - cols);
    } else if (key === KEY_DOWN) {
      idx = Math.min(count - 1, idx + cols);
    }

    db.selectedCardIndex = idx;
  }

  // ---- Dashboard wiring events (for external commands like /flow) ---------

  // Allow external extensions to use the same dashboard state tracking
  // that registered flow commands use, so Ctrl+O works during their execution.
  let lastWiredUi: any = null;

  pi.events?.on("flow:wire-dashboard", (data: any) => {
    if (data?.dashboard && data?.ui) {
      lastWiredUi = data.ui;
      data.renderCallback = wireDashboard(data.dashboard, data.ui);
    }
  });

  pi.events?.on("flow:unwire-dashboard", () => {
    activeDashboard = null;
    dashboardVisible = false;
    if (lastWiredUi) {
      lastWiredUi.setWidget("flow-dashboard", undefined);
      lastWiredUi = null;
    }
  });

  // ---- Event listeners for dependent package registration ----------------

  // Gate registration: dependent packages register gates
  pi.events?.on("flow:register-gate", (data) => {
    const entry = data as GateEntry;
    gates.push(entry);
  });

  // Directory registration: dependent packages register their agent/flow dirs
  pi.events?.on("flow:register-agents-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir && !extraAgentsDirs.includes(dir)) {
      extraAgentsDirs.push(dir);
      // Re-discover to pick up new agents
      init(pkgRoot, projectRoot);
    }
  });

  pi.events?.on("flow:register-flows-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir && !extraFlowsDirs.includes(dir)) {
      extraFlowsDirs.push(dir);
      // Re-discover and register new flows as commands
      const oldFlowNames = new Set(flows.keys());
      init(pkgRoot, projectRoot);
      for (const [name, flow] of flows) {
        if (!oldFlowNames.has(name)) {
          registerFlowCommand(pi, name, flow);
        }
      }
    }
  });

  pi.events?.on("flow:register-skills-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir) registerExtraSkillsDir(dir);
  });

  // Register tools
  registerSubagentTool(
    pi,
    () => agents,
    (role) => getModelRole?.(role),
    guardExtPath,
    projectRoot,
  );

  registerAskUserTool(pi);
  registerSkillReadTool(pi, pkgRoot);

  // Architect tools — used by flow-architect agent during flow design
  registerAgentCatalogTool(pi, () => agents);
  registerAgentValidateTool(pi);
  registerAgentWriteTool(pi);
  registerFlowValidateTool(pi, () => agents);
  registerFlowWriteTool(pi, () => agents);
  registerFlowPreviewTool(pi, () => agents);

  /** Collect AgentConfig objects for all agents referenced by a flow. */
  function extractAgentConfigs(flow: FlowConfig): AgentConfig[] {
    const seen = new Set<string>();
    const configs: AgentConfig[] = [];
    for (const step of flow.steps) {
      if (step.stepType === "agent" && !seen.has(step.agent)) {
        seen.add(step.agent);
        const cfg = agents.get(step.agent);
        if (cfg) configs.push(cfg);
      }
    }
    return configs;
  }

  /** Build a Map of agentName → blockedBy agent names from flow steps. */
  function buildAgentDeps(flow: FlowConfig): Map<string, string[]> {
    const deps = new Map<string, string[]>();
    for (const step of flow.steps) {
      if (
        step.stepType === "agent" &&
        step.blockedBy &&
        step.blockedBy.length > 0
      ) {
        deps.set(step.agent, step.blockedBy);
      }
    }
    return deps;
  }

  /** Wire a dashboard to setWidget using the factory pattern. */
  function wireDashboard(dashboard: any, ui: any) {
    ui.setWidget("flow-summary", undefined);
    summaryVisible = false;
    activeDashboard = dashboard;
    dashboardVisible = true;

    // Create a stable component once — avoid recreation on every spinner tick
    let tuiRef: any = null;
    let themeRef: any = null;
    const component = {
      render(width: number): string[] {
        // Pass terminal dimensions to dashboard for detail view sizing
        dashboard.terminalRows = tuiRef?.terminal?.rows ?? 40;
        const lines = dashboard.render(width, themeRef);
        // Prepend ANSI reset to prevent background bleed from conversation tool output
        if (lines.length > 0) lines[0] = "\x1b[0m" + lines[0];
        return lines;
      },
      invalidate() {
        dashboard.invalidate();
      },
    };

    // Register widget once — factory captures tui/theme refs on first call
    ui.setWidget(
      "flow-dashboard",
      (tuiInstance: any, theme: any) => {
        tuiRef = tuiInstance;
        tui = tuiInstance; // store for requestRender in input routing
        themeRef = theme;
        return component;
      },
      { placement: "aboveEditor" },
    );

    // Spinner callback: invalidate + request render (no setWidget recreation)
    const update = () => {
      component.invalidate();
      tuiRef?.requestRender();
    };
    dashboard.setUpdateCallback(update);
    return update;
  }

  // Register a single flow as a command
  function registerFlowCommand(
    piApi: ExtensionAPI,
    name: string,
    flow: FlowConfig,
  ) {
    piApi.registerCommand(name, {
      description: flow.description || `Run ${name} flow`,
      handler: async (args, ctx) => {
        // Check gates
        const gateMsg = checkGate(name);
        if (gateMsg) {
          ctx.ui.notify(gateMsg, "error");
          return;
        }

        // Try to resolve a workflow dashboard for this flow
        let dashboard: any = null;
        let renderDashboard: (() => void) | undefined;
        try {
          const { AgentDashboard, resolveWorkflow } =
            await import("../flow-dashboard/index.js");
          const resolved = resolveWorkflow(name);
          if (resolved) {
            dashboard = new AgentDashboard(
              resolved.workflow,
              resolved.stageIndex,
              undefined,
            );
            dashboard.preloadAgents(
              extractAgentConfigs(flow),
              buildAgentDeps(flow),
            );
            renderDashboard = wireDashboard(dashboard, ctx.ui);
            renderDashboard();
          }
        } catch {
          /* flow-dashboard not available, continue without dashboard */
        }

        const { runFlow: runFlowFn } = await import("./flow-execution.js");
        try {
          const flowResult = await runFlowFn({
            flow,
            task: args || "",
            cwd: projectRoot,
            guardExtPath,
            getModelRole: (role) => getModelRole?.(role),
            getAgent: (agentName) => agents.get(agentName),
            getSkillContent: (skillName) => {
              const dir = findSkillDir(pkgRoot, skillName);
              if (!dir) return undefined;
              try {
                return readFileSync(join(dir, "SKILL.md"), "utf-8");
              } catch {
                return undefined;
              }
            },
            askUser: async (question, type, options, extra) => {
              if (extra?.multiSelect && options) {
                const selected: string[] = [];
                for (const opt of options) {
                  const yes = await ctx.ui.confirm(
                    `${question}\n  Include "${opt}"?`,
                    "",
                  );
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
            onAgentStarted: dashboard
              ? (agentName: string) => {
                  const config = agents.get(agentName);
                  dashboard.onAgentStarted(agentName, config);
                  renderDashboard!();
                }
              : undefined,
            onAgentComplete: dashboard
              ? (agentName: string, _stepId: string, result: any) => {
                  dashboard.onAgentComplete(agentName, result);
                  renderDashboard!();
                }
              : undefined,
            onToolCall: (agentName: string, toolName: string, input: any) => {
              piApi.events.emit("flow:subagent-tool-call", {
                agentName,
                toolName,
                input,
              });
              if (dashboard) {
                dashboard.onToolCall(agentName, toolName, input);
                renderDashboard!();
              }
            },
            onToolResult: (
              agentName: string,
              toolName: string,
              output: any,
              isError?: boolean,
            ) => {
              piApi.events.emit("flow:subagent-tool-result", {
                agentName,
                toolName,
                output,
                isError,
              });
              if (dashboard) {
                dashboard.onToolResult(agentName, toolName, output, isError);
                renderDashboard!();
              }
            },
            onAssistantText: dashboard
              ? (agentName: string, text: string) => {
                  dashboard.onAssistantText(agentName, text);
                  renderDashboard!();
                }
              : undefined,
            onThinkingText: dashboard
              ? (agentName: string, text: string) => {
                  dashboard.onThinkingText(agentName, text);
                  renderDashboard!();
                }
              : undefined,
          });
          piApi.events.emit("flow:complete", flowResult);
        } finally {
          if (dashboard) {
            lastToolHistory = new Map(dashboard.getAllToolHistory());
            dashboard.dispose();
            ctx.ui.setWidget("flow-dashboard", undefined);
            dashboardVisible = false;
            activeDashboard = null;
          }
        }
      },
    });
  }

  // Register all discovered flows as commands
  for (const [name, flow] of flows) {
    registerFlowCommand(pi, name, flow);
  }

  // Shared helper to run a flow programmatically (with optional dashboard)
  async function runFlowByName(flowName: string, ctxUI?: any) {
    const flowConfig = flows.get(flowName);
    if (!flowConfig) return;

    const gateMsg = checkGate(flowName);
    if (gateMsg) return;

    let dashboard: any = null;
    let renderDashboard: (() => void) | undefined;
    if (ctxUI) {
      try {
        const { AgentDashboard, resolveWorkflow } =
          await import("../flow-dashboard/index.js");
        const resolved = resolveWorkflow(flowName);
        if (resolved) {
          dashboard = new AgentDashboard(
            resolved.workflow,
            resolved.stageIndex,
            undefined,
          );
          dashboard.preloadAgents(
            extractAgentConfigs(flowConfig),
            buildAgentDeps(flowConfig),
          );
          renderDashboard = wireDashboard(dashboard, ctxUI);
          renderDashboard();
        }
      } catch {
        /* no dashboard */
      }
    }

    const { runFlow: runFlowFn } = await import("./flow-execution.js");
    try {
      const flowResult = await runFlowFn({
        flow: flowConfig,
        task: "",
        cwd: projectRoot,
        guardExtPath,
        getModelRole: (role) => getModelRole?.(role),
        getAgent: (agentName) => agents.get(agentName),
        getSkillContent: (skillName) => {
          const dir = findSkillDir(pkgRoot, skillName);
          if (!dir) return undefined;
          try {
            return readFileSync(join(dir, "SKILL.md"), "utf-8");
          } catch {
            return undefined;
          }
        },
        askUser: ctxUI
          ? async (question, type, options, extra) => {
              if (extra?.multiSelect && options) {
                const selected: string[] = [];
                for (const opt of options) {
                  const yes = await ctxUI.confirm(
                    `${question}\n  Include "${opt}"?`,
                    "",
                  );
                  if (yes) selected.push(opt);
                }
                return { answer: selected as any };
              }
              if (type === "select" && options) {
                const answer = await ctxUI.select(question, options);
                return { answer: answer || options[0] };
              }
              if (type === "confirm") {
                const answer = await ctxUI.confirm(question, "");
                return { answer: answer ? "yes" : "no" };
              }
              const answer = await ctxUI.input(question, "");
              return { answer: answer || "" };
            }
          : async (_question, _type, options) => {
              return { answer: options?.[0] || "" };
            },
        onAgentStarted: dashboard
          ? (agentName: string) => {
              const config = agents.get(agentName);
              dashboard.onAgentStarted(agentName, config);
              renderDashboard!();
            }
          : undefined,
        onAgentComplete: dashboard
          ? (agentName: string, _stepId: string, result: any) => {
              dashboard.onAgentComplete(agentName, result);
              renderDashboard!();
            }
          : undefined,
        onToolCall: (agentName: string, toolName: string, input: any) => {
          pi.events.emit("flow:subagent-tool-call", {
            agentName,
            toolName,
            input,
          });
          if (dashboard) {
            dashboard.onToolCall(agentName, toolName, input);
            renderDashboard!();
          }
        },
        onToolResult: (
          agentName: string,
          toolName: string,
          output: any,
          isError?: boolean,
        ) => {
          pi.events.emit("flow:subagent-tool-result", {
            agentName,
            toolName,
            output,
            isError,
          });
          if (dashboard) {
            dashboard.onToolResult(agentName, toolName, output, isError);
            renderDashboard!();
          }
        },
        onAssistantText: dashboard
          ? (agentName: string, text: string) => {
              dashboard.onAssistantText(agentName, text);
              renderDashboard!();
            }
          : undefined,
        onThinkingText: dashboard
          ? (agentName: string, text: string) => {
              dashboard.onThinkingText(agentName, text);
              renderDashboard!();
            }
          : undefined,
      });
      pi.events.emit("flow:complete", flowResult);
    } finally {
      if (dashboard) {
        lastToolHistory = new Map(dashboard.getAllToolHistory());
        dashboard.dispose();
        if (ctxUI) ctxUI.setWidget("flow-dashboard", undefined);
        dashboardVisible = false;
        activeDashboard = null;
      }
    }
  }

  // Handle programmatic flow invocation from dependent packages
  pi.events?.on("flow:run", async (data: any) => {
    await runFlowByName(data?.flowName, data?.ctx);
  });

  pi.events.on("flow:rediscover", () => {
    init(pkgRoot, projectRoot);
  });

  // Expose discovery state to other extensions (avoids module identity issues with dynamic imports)
  pi.events.on("flow:get-agents", (data: any) => {
    data.agents = agents;
  });

  pi.events.on("flow:get-flows", (data: any) => {
    data.flows = flows;
  });
}
