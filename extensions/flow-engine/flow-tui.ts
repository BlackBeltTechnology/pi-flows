// ---------------------------------------------------------------------------
// Flow TUI — Dashboard rendering, keyboard handling, and TUI observers
//
// All TUI-specific rendering and interaction code extracted from index.ts.
// Exports setupFlowTui() which wires everything into the extension lifecycle.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentResult, FlowConfig, FlowResult } from "./types.js";
import type { FlowObserver } from "./flow-io.js";
import type { FlowManager } from "./flow-manager.js";
import { GridComponent } from "../flow-dashboard/grid-component.js";
import { createAgentDetailOverlay } from "../flow-dashboard/agent-detail-overlay.js";
import { setFlowWidget } from "../shared/flow-widget.js";
import { getSummaryState, setSummaryState } from "../flow-summary/index.js";
import { isAutonomousMode, setAutonomousMode } from "../provider-register.js";

// ---- Module-scoped state ---------------------------------------------------

let activeDashboard: any = null;
let lastFlowResult: FlowResult | null = null;
let lastToolHistory: Map<string, any[]> | null = null;
let lastCards: Map<string, any> | null = null;
let uiCtx: any = null;
let tui: any = null;
let overlayOpen = false;
let overlayDone: ((result: null) => void) | null = null;

// Lifecycle-scoped input handler unsubscribers
let unsubDashboardInput: (() => void) | null = null;
let unsubSummaryInput: (() => void) | null = null;

// ---- Key constants ---------------------------------------------------------

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
const KEY_CTRL_A = "\x01";

// ---- Helpers ---------------------------------------------------------------

function requestRender() {
  tui?.requestRender();
}

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

// ---- Lifecycle-scoped input handler registration ---------------------------

/**
 * Register the dashboard input handler. Called when the dashboard widget mounts.
 * Returns an unsubscribe function. The handler is automatically removed when called.
 */
function registerDashboardInputHandler(flowManager: FlowManager): () => void {
  if (!uiCtx) return () => {};

  // Unsubscribe any stale summary handler — dashboard replaces summary
  unregisterSummaryInputHandler();

  const unsub = uiCtx.onTerminalInput((data: string) => {
    if (overlayOpen) return undefined;

    if (!activeDashboard) return undefined;

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
      } else if (data === KEY_CTRL_O || data === KEY_ESC) {
        db.mode = "passive";
        requestRender();
      } else if (
        data === KEY_UP ||
        data === KEY_DOWN ||
        data === KEY_LEFT ||
        data === KEY_RIGHT
      ) {
        navigateCard(db, data);
        requestRender();
      } else if (data === KEY_ENTER) {
        const names = db.getAgentNames();
        const name = names[db.selectedCardIndex];
        if (name) {
          const card = db.getCard(name);
          const entries = db.getEventLog(name);
          openDetailOverlay(name, card?.status || "unknown", undefined, entries);
        }
      }
      // Navigate mode consumes ALL input — prevent typing into editor
      return { consume: true };
    }

    return undefined;
  });

  unsubDashboardInput = unsub;
  return unsub;
}

/**
 * Unregister the dashboard input handler.
 */
function unregisterDashboardInputHandler(): void {
  if (unsubDashboardInput) {
    unsubDashboardInput();
    unsubDashboardInput = null;
  }
}

/**
 * Register the summary input handler. Called when the summary widget mounts.
 */
function registerSummaryInputHandler(): void {
  if (!uiCtx) return;

  const unsub = uiCtx.onTerminalInput((data: string) => {
    const summaryState = getSummaryState();
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
        if (uiCtx) setFlowWidget(uiCtx, "flow-summary", undefined);
        unregisterSummaryInputHandler();
        setSummaryState(null);
        requestRender();
        return { consume: true };
      }
      return undefined;
    }

    if (mode === "navigate") {
      if (data === KEY_CTRL_O || data === KEY_ESC || data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
        summaryState.mode = "summary";
        requestRender();
      } else if (data === KEY_UP) {
        if (summaryState.selectedIndex > 0) summaryState.selectedIndex--;
        requestRender();
      } else if (data === KEY_DOWN) {
        if (summaryState.selectedIndex < summaryState.agentNames.length - 1)
          summaryState.selectedIndex++;
        requestRender();
      } else if (data === KEY_ENTER) {
        const name = summaryState.agentNames[summaryState.selectedIndex];
        if (name) {
          const result = lastFlowResult?.results?.[name];
          const entries = lastToolHistory?.get(name) || [];
          openDetailOverlay(name, result?.status || "unknown", result?.summary, entries);
        }
      }
      // Navigate mode consumes ALL input — prevent typing into editor
      return { consume: true };
    }

    return undefined;
  });

  unsubSummaryInput = unsub;
}

/**
 * Unregister the summary input handler.
 * Exported so flow-workspace can clear it when the architect widget mounts.
 */
export function unregisterSummaryInputHandler(): void {
  if (unsubSummaryInput) {
    unsubSummaryInput();
    unsubSummaryInput = null;
  }
}

// ---- wireDashboard ---------------------------------------------------------

function wireDashboard(dashboard: any, ui: any, flowManager: FlowManager) {
  // Unregister stale summary handler and register dashboard handler
  unregisterSummaryInputHandler();
  activeDashboard = dashboard;
  registerDashboardInputHandler(flowManager);

  let tuiRef: any = null;
  let themeRef: any = null;
  let disposed = false;
  const component = {
    render(width: number): string[] {
      if (disposed) return [];
      const lines = dashboard.render(width, themeRef);
      for (let i = 0; i < lines.length; i++) {
        lines[i] = "\x1b[0m" + lines[i];
      }
      return lines;
    },
    invalidate() {
      if (!disposed) dashboard.invalidate();
    },
    dispose() {
      disposed = true;
      tuiRef = null;
      themeRef = null;
    },
  };

  setFlowWidget(
    ui,
    "flow-dashboard",
    (tuiInstance: any, theme: any) => {
      tuiRef = tuiInstance;
      tui = tuiInstance;
      themeRef = theme;
      return component;
    },
  );

  process.nextTick(() => { tuiRef?.requestRender(true); });

  const update = () => {
    if (disposed) return;
    component.invalidate();
    if (dashboard.forceNextRender) {
      dashboard.forceNextRender = false;
      tuiRef?.requestRender(true);
    } else {
      tuiRef?.requestRender();
    }
  };
  dashboard.setUpdateCallback(update);
  return update;
}

// ---- TuiFlowObserver -------------------------------------------------------

export class TuiFlowObserver implements FlowObserver {
  private dashboard: any = null;
  private renderDashboard: (() => void) | undefined;
  private pi: ExtensionAPI;
  private flowManager: FlowManager;
  private extractAgentConfigs: (flow: FlowConfig) => AgentConfig[];
  private buildAgentDeps: (flow: FlowConfig) => Map<string, string[]>;

  constructor(options: {
    pi: ExtensionAPI;
    flowManager: FlowManager;
    extractAgentConfigs: (flow: FlowConfig) => AgentConfig[];
    buildAgentDeps: (flow: FlowConfig) => Map<string, string[]>;
  }) {
    this.pi = options.pi;
    this.flowManager = options.flowManager;
    this.extractAgentConfigs = options.extractAgentConfigs;
    this.buildAgentDeps = options.buildAgentDeps;
  }

  async onFlowStarted(flowName: string, flow: FlowConfig, _task: string): Promise<void> {
    try {
      const { AgentDashboard, resolveWorkflow } =
        await import("../flow-dashboard/index.js");
      const resolved = resolveWorkflow(flowName);
      this.dashboard = new AgentDashboard(
        resolved?.workflow ?? null,
        resolved?.stageIndex ?? 0,
        flowName,
        undefined,
      );
      this.dashboard.preloadAgents(
        this.extractAgentConfigs(flow),
        this.buildAgentDeps(flow),
      );
      this.renderDashboard = wireDashboard(this.dashboard, uiCtx, this.flowManager);
      this.renderDashboard();
    } catch {
      /* flow-dashboard not available */
    }
  }

  onAgentStarted(agentName: string, _stepId: string, config?: AgentConfig): void {
    if (this.dashboard) {
      this.dashboard.onAgentStarted(agentName, config);
      this.renderDashboard!();
    }
  }

  onAgentComplete(agentName: string, _stepId: string, result: AgentResult): void {
    if (this.dashboard) {
      this.dashboard.onAgentComplete(agentName, result);
      this.renderDashboard!();
    }
  }

  onToolCall(agentName: string, toolName: string, input: any): void {
    if (this.dashboard) {
      this.dashboard.onToolCall(agentName, toolName, input);
      this.renderDashboard!();
    }
  }

  onToolResult(agentName: string, toolName: string, output: any, isError: boolean): void {
    if (this.dashboard) {
      this.dashboard.onToolResult(agentName, toolName, output, isError);
      this.renderDashboard!();
    }
  }

  onAssistantText(agentName: string, text: string): void {
    if (this.dashboard) {
      this.dashboard.onAssistantText(agentName, text);
      this.renderDashboard!();
    }
  }

  onThinkingText(agentName: string, text: string): void {
    if (this.dashboard) {
      this.dashboard.onThinkingText(agentName, text);
      this.renderDashboard!();
    }
  }

  onLoopIteration(stepId: string, iteration: number, maxIterations: number, loopTarget?: string): void {
    if (this.dashboard && loopTarget) {
      // Only set loop badge on the loop target agent — this is the step
      // the loop jumps back to. Other agents outside the loop should not
      // show the badge.
      const card = this.dashboard.getCard(loopTarget);
      if (card) {
        card.loopIteration = iteration;
        card.loopMax = maxIterations;
      }
      this.renderDashboard!();
    }
  }

  onFlowComplete(flowName: string, result: FlowResult): void {
    // Snapshot dashboard state before disposing
    if (this.dashboard) {
      lastToolHistory = new Map(this.dashboard.getAllToolHistory());
      lastCards = new Map(this.dashboard.getAllCards());
      this.dashboard.dispose();
      if (uiCtx) setFlowWidget(uiCtx, "flow-dashboard", undefined);
      // Unregister the dashboard input handler
      unregisterDashboardInputHandler();
      activeDashboard = null;
      tui?.requestRender(true);
    }
    this.dashboard = null;
    this.renderDashboard = undefined;

    // Store result and show summary
    lastFlowResult = result;

    // Ensure dashboard widget is removed (safety net)
    if (activeDashboard) {
      if (uiCtx) setFlowWidget(uiCtx, "flow-dashboard", undefined);
      unregisterDashboardInputHandler();
      activeDashboard = null;
    }

    // Share tool history and preserved cards with summary widget
    // MUST happen before flow:complete is emitted (flow-summary depends on this ordering)
    this.pi.events.emit("flow:set-summary-context", {
      toolHistory: lastToolHistory,
      cards: lastCards,
    });

    // Register lifecycle-scoped summary input handler
    registerSummaryInputHandler();

    // Notify user of errors
    if (result.status === "error") {
      const summary = result.lastResult?.result?.summary || "Unknown error";
      uiCtx?.notify?.(`Flow "${flowName}" failed: ${summary}`, "error");
    }
  }
}

// ---- EventEmitObserver -----------------------------------------------------

export class EventEmitObserver implements FlowObserver {
  constructor(private pi: ExtensionAPI) {}

  onToolCall(agentName: string, toolName: string, input: any): void {
    this.pi.events.emit("flow:subagent-tool-call", { agentName, toolName, input });
  }

  onToolResult(agentName: string, toolName: string, output: any, isError: boolean): void {
    this.pi.events.emit("flow:subagent-tool-result", { agentName, toolName, output, isError });
  }

  onAutoDecision(forkId: string, agentName: string, chosenBranch: string, targetStepId: string): void {
    this.pi.events.emit("flow:auto-decision", { forkId, agentName, chosenBranch, targetStepId });
  }

  onLoopIteration(stepId: string, iteration: number, maxIterations: number, loopTarget?: string): void {
    this.pi.events.emit("flow:loop-iteration", { stepId, iteration, maxIterations, loopTarget });
  }

  onFlowComplete(_flowName: string, result: FlowResult): void {
    this.pi.events.emit("flow:complete", result);
  }
}

// ---- isOverlayOpen (exported for TuiFlowIOAdapter) -------------------------

export function getIsOverlayOpen(): boolean {
  return overlayOpen;
}

// ---- setupFlowTui ----------------------------------------------------------

/**
 * Wire TUI-specific flow infrastructure into the extension lifecycle.
 * Called from index.ts during activate() — only when ctx.hasUI is true.
 */
export function setupFlowTui(
  pi: ExtensionAPI,
  flowManager: FlowManager,
): void {
  // Register keyboard handler on session_start
  pi.on("session_start", (_event: any, ctx: any) => {
    uiCtx = ctx.ui;

    // Register autonomous mode footer segment (must happen at session_start,
    // after flow-footer's activate() has registered the event listener)
    let invalidateAutoFooter: (() => void) | null = null;
    pi.events?.emit("flow:register-footer-segment", {
      name: "autonomous-mode",
      render: (theme?: any) => {
        const label = "AUTO";
        if (!theme?.fg) return isAutonomousMode() ? label : null;
        return isAutonomousMode() ? theme.fg("accent", label) : theme.fg("dim", label);
      },
      onRegistered: (invalidate: () => void) => {
        invalidateAutoFooter = invalidate;
      },
    });
    if (ctx.hasUI) {
      // Print help once at session start
      const lines = [
        "  /flows              Manage flows (new, edit, delete)",
        "  /flows:new          Design & run a new flow",
        "  /flows:edit         Edit an existing flow",
        "  /flows:delete       Delete a flow",
        "  /provider           Manage LLM providers",
        "  /roles              Assign model roles",
        "  /catalog            Manage model catalog",
        "",
        "  Ctrl+A              Toggle auto-routing",
        "",
      ];
      pi.sendMessage({
        customType: "pi-flows-help",
        content: lines.join("\n"),
        display: true,
      });
    }
    ctx.ui.onTerminalInput((data: string) => {
      // Global: Ctrl+A toggles autonomous mode anytime
      if (data === KEY_CTRL_A) {
        setAutonomousMode(!isAutonomousMode());
        requestRender();
        invalidateAutoFooter?.();
        return { consume: true };
      }
      // Global: Ctrl+X aborts running flow anytime
      if (data === KEY_CTRL_X && flowManager.isRunning) {
        flowManager.abort();
        return { consume: true };
      }
      // All other keys pass through — dashboard and summary input handlers
      // are registered/unregistered with their widget lifecycles.
      return undefined;
    });
  });
}
