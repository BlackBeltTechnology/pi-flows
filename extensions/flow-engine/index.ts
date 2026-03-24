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

import { GridComponent } from "../flow-dashboard/grid-component.js";
import { createAgentDetailOverlay } from "../flow-dashboard/agent-detail-overlay.js";

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

// ---- Flow Manager ----------------------------------------------------------

interface ActiveFlow {
  promise: Promise<FlowResult>;
  abortController: AbortController;
  flowName: string;
  dashboard: any;
  renderDashboard: (() => void) | undefined;
  ui: any;
}

interface FlowManagerDeps {
  pi: ExtensionAPI;
  getAgents: () => Map<string, AgentConfig>;
  getGuardExtPath: () => string;
  getModelRole: () => ((role: string) => string | undefined) | undefined;
  getProjectRoot: () => string;
  getPkgRoot: () => string;
  extractAgentConfigs: (flow: FlowConfig) => AgentConfig[];
  buildAgentDeps: (flow: FlowConfig) => Map<string, string[]>;
  wireDashboard: (dashboard: any, ui: any) => () => void;
  onFlowCleanup: (activeFlow: ActiveFlow) => void;
  isOverlayOpen: () => boolean;
}

class FlowManager {
  private _activeFlow: ActiveFlow | null = null;
  private deps: FlowManagerDeps;

  constructor(deps: FlowManagerDeps) {
    this.deps = deps;
  }

  get isRunning(): boolean {
    return this._activeFlow !== null;
  }

  get activeFlowName(): string | null {
    return this._activeFlow?.flowName ?? null;
  }

  abort(): void {
    this._activeFlow?.abortController.abort();
  }

  async start(options: {
    flow: FlowConfig;
    flowName: string;
    task: string;
    ui: any;
    dashboard: any;
    renderDashboard: (() => void) | undefined;
  }): Promise<void> {
    if (this._activeFlow) {
      throw new Error("A flow is already running");
    }

    const { flow, flowName, task, ui, dashboard, renderDashboard } = options;
    const abortController = new AbortController();
    const { pi, getAgents, getGuardExtPath, getModelRole, getProjectRoot, getPkgRoot } = this.deps;

    // Dynamic import to avoid circular deps
    const { runFlow: runFlowFn } = await import("./flow-execution.js");

    const promise = runFlowFn({
      flow,
      task,
      cwd: getProjectRoot(),
      guardExtPath: getGuardExtPath(),
      signal: abortController.signal,
      getModelRole: (role) => getModelRole()?.(role),
      getAgent: (agentName) => getAgents().get(agentName),
      getSkillContent: (skillName) => {
        const dir = findSkillDir(getPkgRoot(), skillName);
        if (!dir) return undefined;
        try {
          return readFileSync(join(dir, "SKILL.md"), "utf-8");
        } catch {
          return undefined;
        }
      },
      askUser: ui
        ? async (question: string, type: string, askOptions?: string[], extra?: any) => {
            // Wait for any open detail overlay to close naturally before
            // showing the ask-user prompt — never steal focus from the overlay.
            while (this.deps.isOverlayOpen()) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (extra?.multiSelect && askOptions) {
              const selected: string[] = [];
              for (const opt of askOptions) {
                const yes = await ui.confirm(
                  `${question}\n  Include "${opt}"?`,
                  "",
                );
                if (yes) selected.push(opt);
              }
              return { answer: selected as any };
            }
            if (type === "select" && askOptions) {
              const answer = await ui.select(question, askOptions);
              return { answer: answer || askOptions[0] };
            }
            if (type === "confirm") {
              const answer = await ui.confirm(question, "");
              return { answer: answer ? "yes" : "no" };
            }
            const answer = await ui.input(question, "");
            return { answer: answer || "" };
          }
        : async (_question: string, _type: string, askOptions?: string[]) => {
            return { answer: askOptions?.[0] || "" };
          },
      onAgentStarted: dashboard
        ? (agentName: string) => {
            const config = getAgents().get(agentName);
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
      onLoopIteration: dashboard
        ? (stepId: string, iteration: number, maxIterations: number) => {
            pi.events.emit("flow:loop-iteration", { stepId, iteration, maxIterations });
            for (const name of dashboard.getAgentNames()) {
              const card = dashboard.getCard(name);
              if (card) {
                card.loopIteration = iteration;
                card.loopMax = maxIterations;
              }
            }
            renderDashboard!();
          }
        : undefined,
    });

    this._activeFlow = { promise, abortController, flowName, dashboard, renderDashboard, ui };

    // Fire-and-forget with lifecycle cleanup
    const safeCleanup = () => {
      try {
        if (this._activeFlow) {
          this.deps.onFlowCleanup(this._activeFlow);
        }
      } catch {
        /* cleanup must never throw — prevent deadlock from stuck isRunning */
      } finally {
        this._activeFlow = null;
      }
    };

    promise
      .then((flowResult: FlowResult) => {
        safeCleanup();
        pi.events.emit("flow:complete", flowResult);
      })
      .catch((err: any) => {
        const wasAborted = abortController.signal.aborted;
        safeCleanup();
        if (!wasAborted) {
          // Surface the error to the user — don't swallow silently
          const msg = err instanceof Error ? err.message : String(err);
          ui?.notify?.(`Flow "${flowName}" failed: ${msg}`, "error");
        }
      });
  }
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
  let lastCards: Map<string, any> | null = null;
  let uiCtx: any = null;
  let tui: any = null; // TUI reference for requestRender
  let themeRef: any = null; // theme reference for overlay rendering

  let overlayOpen = false; // true while an overlay is showing (skip input handling)
  let overlayDone: ((result: null) => void) | null = null; // stored callback to close overlay externally

  // Flow manager — declared here, initialized after helper functions are defined
  let flowManager: FlowManager;

  // Global summary state registry (shared with flow-summary via Symbol.for)
  const SUMMARY_STATE_KEY = Symbol.for("pi-flow-summary-state");

  pi.on("session_start", (_event: any, ctx: any) => {
    uiCtx = ctx.ui;
    if (ctx.hasUI) {
      // Print help once at session start, not as a persistent widget
      const lines = [
        "  /flows              Manage flows (new, edit, delete)",
        "  /flows:new          Design & run a new flow",
        "  /flows:edit         Edit an existing flow",
        "  /flows:delete       Delete a flow",
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
    // Share tool history and preserved cards with summary widget
    pi.events.emit("flow:set-summary-context", {
      toolHistory: lastToolHistory,
      cards: lastCards,
    });
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
  const KEY_CTRL_X = "\x18";

  function requestRender() {
    tui?.requestRender();
  }

  /** Close the detail overlay if one is currently open. */
  function closeDetailOverlay(): void {
    if (overlayOpen && overlayDone) {
      overlayDone(null);
      // overlayOpen and overlayDone are cleared in the finally block of openDetailOverlay
    }
  }

  /** Open agent detail as overlay — fire-and-forget from input handler. */
  async function openDetailOverlay(agentName: string, status: string, summary: string | undefined, entries: any[]) {
    if (!uiCtx) return;
    overlayOpen = true;
    try {
      await uiCtx.custom(
        (tuiInstance: any, theme: any, _kb: any, done: (r: null) => void) => {
          overlayDone = done;
          return createAgentDetailOverlay({
            agentName,
            status,
            summary,
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
    } catch {
      /* overlay not available */
    } finally {
      overlayOpen = false;
      overlayDone = null;
    }
  }

  function handleDashboardInput(data: string): { consume: true } | undefined {
    // Skip input handling while an overlay is open (overlay handles its own keys)
    if (overlayOpen) return undefined;

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
        if (data === KEY_CTRL_X) {
          flowManager.abort();
          return { consume: true };
        }
        return undefined;
      }

      if (mode === "navigate") {
        if (data === KEY_CTRL_X) {
          flowManager.abort();
          db.mode = "passive";
          requestRender();
          return { consume: true };
        }
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
            const card = db.getCard(name);
            const entries = db.getEventLog(name);
            openDetailOverlay(name, card?.status || "unknown", undefined, entries);
          }
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
    const summaryState = (globalThis as any)[SUMMARY_STATE_KEY] as any;
    if (!summaryState) return undefined;

    const mode = summaryState.mode;

    if (mode === "summary") {
      if (data === KEY_CTRL_O) {
        summaryState.mode = "navigate";
        summaryState.selectedIndex = 0;
        requestRender();
        return { consume: true };
      }
      if (data === KEY_CTRL_X) {
        // Dismiss the summary widget entirely
        uiCtx?.setWidget?.("flow-summary", undefined);
        summaryVisible = false;
        (globalThis as any)[SUMMARY_STATE_KEY] = null;
        requestRender();
        return { consume: true };
      }
      return undefined;
    }

    if (mode === "navigate") {
      if (data === KEY_CTRL_O || data === KEY_ESC || data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
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
          const result = lastFlowResult?.results?.[name];
          const entries = lastToolHistory?.get(name) || [];
          openDetailOverlay(name, result?.status || "unknown", result?.summary, entries);
        }
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
        themeRef = theme; // store for overlay rendering
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

  // ── Initialize FlowManager ──
  flowManager = new FlowManager({
    pi,
    getAgents: () => agents,
    getGuardExtPath: () => guardExtPath,
    getModelRole: () => getModelRole,
    getProjectRoot: () => projectRoot,
    getPkgRoot: () => pkgRoot,
    extractAgentConfigs,
    buildAgentDeps,
    wireDashboard,
    isOverlayOpen: () => overlayOpen,
    onFlowCleanup: (activeFlow: ActiveFlow) => {
      if (activeFlow.dashboard) {
        lastToolHistory = new Map(activeFlow.dashboard.getAllToolHistory());
        lastCards = new Map(activeFlow.dashboard.getAllCards());
        activeFlow.dashboard.dispose();
        activeFlow.ui?.setWidget("flow-dashboard", undefined);
        dashboardVisible = false;
        activeDashboard = null;
      }
    },
  });

  // Register a single flow as a command
  function registerFlowCommand(
    piApi: ExtensionAPI,
    name: string,
    flow: FlowConfig,
  ) {
    piApi.registerCommand(name, {
      description: flow.description || `Run ${name} flow`,
      handler: async (args, ctx) => {
        // Mutex: only one flow at a time
        if (flowManager.isRunning) {
          ctx.ui.notify(`A flow is already running (${flowManager.activeFlowName})`, "error");
          return;
        }

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
          const workflow = resolved
            ? resolved.workflow
            : { id: name, stages: [{ name, flows: [name] }] };
          const stageIndex = resolved ? resolved.stageIndex : 0;
          dashboard = new AgentDashboard(
            workflow,
            stageIndex,
            undefined,
          );
          dashboard.preloadAgents(
            extractAgentConfigs(flow),
            buildAgentDeps(flow),
          );
          renderDashboard = wireDashboard(dashboard, ctx.ui);
          renderDashboard();
        } catch {
          /* flow-dashboard not available, continue without dashboard */
        }

        // Non-blocking: start the flow and return immediately
        await flowManager.start({
          flow,
          flowName: name,
          task: args || "",
          ui: ctx.ui,
          dashboard,
          renderDashboard,
        });
      },
    });
  }

  // Register all discovered flows as commands
  for (const [name, flow] of flows) {
    registerFlowCommand(pi, name, flow);
  }

  // Shared helper to run a flow programmatically (with optional dashboard)
  async function runFlowByName(flowName: string, ctxUI?: any) {
    if (flowManager.isRunning) return;

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
        const workflow = resolved
          ? resolved.workflow
          : { id: flowName, stages: [{ name: flowName, flows: [flowName] }] };
        const stageIndex = resolved ? resolved.stageIndex : 0;
        dashboard = new AgentDashboard(
          workflow,
          stageIndex,
          undefined,
        );
        dashboard.preloadAgents(
          extractAgentConfigs(flowConfig),
          buildAgentDeps(flowConfig),
        );
        renderDashboard = wireDashboard(dashboard, ctxUI);
        renderDashboard();
      } catch {
        /* no dashboard */
      }
    }

    // Non-blocking: start the flow and return immediately
    await flowManager.start({
      flow: flowConfig,
      flowName,
      task: "",
      ui: ctxUI,
      dashboard,
      renderDashboard,
    });
  }

  // Handle programmatic flow invocation from dependent packages
  pi.events?.on("flow:run", async (data: any) => {
    if (flowManager.isRunning) return;
    await runFlowByName(data?.flowName, data?.ctx);
  });

  pi.events.on("flow:rediscover", () => {
    const oldFlowNames = new Set(flows.keys());
    init(pkgRoot, projectRoot);
    // Register commands for any newly discovered flows
    for (const [name, flow] of flows) {
      if (!oldFlowNames.has(name)) {
        registerFlowCommand(pi, name, flow);
      }
    }
  });

  // Expose discovery state to other extensions (avoids module identity issues with dynamic imports)
  pi.events.on("flow:get-agents", (data: any) => {
    data.agents = agents;
  });

  pi.events.on("flow:get-flows", (data: any) => {
    data.flows = flows;
  });
}
