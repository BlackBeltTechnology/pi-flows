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
import { getSummaryState, setSummaryState, getLastEventLog, getLastCards } from "../flow-summary/index.js";
import { Text } from "@mariozechner/pi-tui";
import { renderBox } from "../flow-dashboard/box-renderer.js";
import { isAutonomousMode, setAutonomousMode } from "../role-manager.js";
import { join } from "node:path";

// ---- Module-scoped state ---------------------------------------------------

let activeDashboard: any = null;
let lastToolHistory: Map<string, any[]> | null = null;
let lastCards: Map<string, any> | null = null;
let uiCtx: any = null;
let tui: any = null;
let overlayOpen = false;
let overlayDone: ((result: null) => void) | null = null;
let piRef: ExtensionAPI | null = null;

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
        piRef?.events?.emit("flow:summary-dismissed", {});
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
          const result = summaryState.flowResult?.results?.[name];
          const entries = getLastEventLog()?.get(name) || [];
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

  onAgentStarted(agentName: string, _stepId: string, config?: AgentConfig, resolvedModel?: string): void {
    if (this.dashboard) {
      this.dashboard.onAgentStarted(agentName, config, resolvedModel);
      this.renderDashboard!();
    }
  }

  onAgentComplete(agentName: string, _stepId: string, result: AgentResult): void {
    if (this.dashboard) {
      this.dashboard.onAgentComplete(agentName, result);
      this.renderDashboard!();
    }
    // Notify user immediately when an agent reports "blocked"
    if (result.result?.status === "blocked") {
      const summary = result.result.summary || "No details provided";
      uiCtx?.notify?.(`Agent "${agentName}" blocked: ${summary}`, "warning");
    }
  }

  onToolCall(agentName: string, _stepId: string, toolName: string, input: any): void {
    if (this.dashboard) {
      this.dashboard.onToolCall(agentName, toolName, input);
      this.renderDashboard!();
    }
  }

  onToolResult(agentName: string, _stepId: string, toolName: string, output: any, isError: boolean): void {
    if (this.dashboard) {
      this.dashboard.onToolResult(agentName, toolName, output, isError);
      this.renderDashboard!();
    }
  }

  onAssistantText(agentName: string, _stepId: string, text: string): void {
    if (this.dashboard) {
      this.dashboard.onAssistantText(agentName, text);
      this.renderDashboard!();
    }
  }

  onThinkingText(agentName: string, _stepId: string, text: string): void {
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

    // Ensure dashboard widget is removed (safety net)
    if (activeDashboard) {
      if (uiCtx) setFlowWidget(uiCtx, "flow-dashboard", undefined);
      unregisterDashboardInputHandler();
      activeDashboard = null;
    }

    // Share tool history and preserved cards with summary extension
    // MUST happen before flow:complete is emitted (flow-summary depends on this ordering)
    this.pi.events.emit("flow:set-summary-context", {
      toolHistory: lastToolHistory,
      cards: lastCards,
    });

    // NOTE: Summary input handler is now registered by setupFlowTui's
    // flow:summary-ready listener, keeping TUI concerns out of the observer.

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

  onFlowStarted(flowName: string, flow: FlowConfig, task: string): void {
    // Serialize minimal step metadata for external consumers (dashboards, etc.)
    // Avoids sending full AgentConfig.systemPrompt (can be very large)
    const steps = flow.steps.map(step => ({
      id: step.id,
      stepType: step.stepType,
      agent: (step as any).agent,
      blockedBy: (step as any).blockedBy || [],
      loopTarget: (step as any).loop_target,
      exitTarget: (step as any).exit_target,
    }));
    this.pi.events.emit("flow:flow-started", {
      flowName,
      task,
      steps,
      description: flow.description,
      maxConcurrent: flow.max_concurrent,
      autonomousMode: isAutonomousMode(),
      source: flow.source,
    });
  }

  onAgentStarted(agentName: string, stepId: string, config?: AgentConfig, resolvedModel?: string): void {
    this.pi.events.emit("flow:agent-started", {
      agentName,
      stepId,
      resolvedModel,
      config: config ? {
        name: config.name,
        description: config.description,
        model: config.model,
        card: config.card,
        sourcePath: config.source,
      } : undefined,
    });
  }

  onAgentComplete(agentName: string, stepId: string, result: AgentResult): void {
    this.pi.events.emit("flow:agent-complete", {
      agentName,
      stepId,
      result: {
        success: result.success,
        status: result.result?.status,
        summary: result.result?.summary,
        files: result.result?.files?.map(f => f.path) || [],
        tokens: result.tokens,
        duration: result.duration,
      },
    });
  }

  onAssistantText(agentName: string, stepId: string, text: string): void {
    this.pi.events.emit("flow:assistant-text", { agentName, stepId, text });
  }

  onThinkingText(agentName: string, stepId: string, text: string): void {
    this.pi.events.emit("flow:thinking-text", { agentName, stepId, text });
  }

  onToolCall(agentName: string, stepId: string, toolName: string, input: any): void {
    this.pi.events.emit("flow:subagent-tool-call", { agentName, stepId, toolName, input });
  }

  onToolResult(agentName: string, stepId: string, toolName: string, output: any, isError: boolean): void {
    this.pi.events.emit("flow:subagent-tool-result", { agentName, stepId, toolName, output, isError });
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

// ---- Braille spinner frames (for summary widget) --------------------------



// ---- setupFlowTui ----------------------------------------------------------

/**
 * Wire TUI-specific flow infrastructure into the extension lifecycle.
 * Called from index.ts during activate() — only when ctx.hasUI is true.
 */
export function setupFlowTui(
  pi: ExtensionAPI,
  flowManager: FlowManager,
): void {
  piRef = pi;

  // ── Legacy prompt request/response handler REMOVED ──
  // Previously listened for flow:prompt-request and presented via proxied uiCtx,
  // causing duplicate prompts on the dashboard. Now handled by TuiPromptAdapter
  // registered with the PromptBus (see tui-prompt-adapter.ts).

  // ── Architect TUI adapter (driven by events from flow-workspace) ──
  // Mounts/unmounts the architect widget, handles keyboard, overlays,
  // and maps typed lifecycle events to TUI notifications.

  let architectWidget: any = null;
  let widgetTuiRef: any = null;
  let architectOverlayOpen = false;
  let unsubArchitectInput: (() => void) | null = null;

  function architectRender() {
    widgetTuiRef?.requestRender();
  }

  async function openArchitectFlowOverlay(content: string) {
    if (!uiCtx) return;
    architectOverlayOpen = true;
    try {
      const { parseFlowYamlString } = await import("./flow-parser-yaml.js");
      const flowConfig = parseFlowYamlString(content, "<preview>");
      const { createFlowPreviewOverlay } = await import("../flow-dashboard/flow-preview-overlay.js");
      await uiCtx.custom(
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
    finally { architectOverlayOpen = false; }
  }

  async function mountArchitectWidget(resolveAgentType?: (name: string) => "built-in" | "local") {
    if (!uiCtx) return;
    // Clear stale summary input handler so it doesn't steal keybinds from architect
    unregisterSummaryInputHandler();
    try {
      const { createArchitectWidget } = await import("../flow-dashboard/architect-widget.js");
      architectWidget = createArchitectWidget({ resolveAgentType });
      const wrappedFactory = (t: any, theme: any) => {
        widgetTuiRef = t;
        return architectWidget.factory(t, theme);
      };
      setFlowWidget(uiCtx, "flow-architect", wrappedFactory);
      architectWidget.setUpdateCallback(architectRender);
    } catch { /* widget not available */ }
  }

  function unmountArchitectWidget() {
    if (architectWidget) {
      architectWidget.dispose();
      architectWidget = null;
    }
    if (uiCtx) {
      setFlowWidget(uiCtx, "flow-architect", undefined);
      widgetTuiRef?.requestRender(true);
    }
    if (unsubArchitectInput) {
      unsubArchitectInput();
      unsubArchitectInput = null;
    }
  }

  function registerArchitectKeyboard(piRef: ExtensionAPI) {
    if (!uiCtx) return;
    // Unsubscribe previous handler if any
    if (unsubArchitectInput) {
      unsubArchitectInput();
      unsubArchitectInput = null;
    }
    unsubArchitectInput = uiCtx.onTerminalInput((data: string) => {
      // Ctrl+X: abort the architect agent (always takes priority)
      if (data === KEY_CTRL_X) {
        piRef.events.emit("flow:architect-abort", {});
        // Mirror to a FLOW_EVENT_MAP-bridged event so dashboard observers see the cancellation.
        piRef.events.emit("flow:architect-cancelled", { reason: "user-abort" });
        return { consume: true };
      }

      // Handle inline prompt input (highest priority after abort)
      if (architectWidget?.hasActivePrompt?.()) {
        if (architectWidget.handlePromptInput(data)) {
          architectRender();
          return { consume: true };
        }
      }

      // Handle navigate mode keyboard input
      if (architectWidget && architectWidget.getPreviewSubMode?.() === "navigate" && !architectOverlayOpen) {
        if (data === KEY_UP) {
          const idx = architectWidget.getSelectedFlowIndex();
          if (idx > 0) architectWidget.setSelectedFlowIndex(idx - 1);
        } else if (data === KEY_DOWN) {
          const idx = architectWidget.getSelectedFlowIndex();
          architectWidget.setSelectedFlowIndex(idx + 1);
        } else if (data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
          architectWidget.setPreviewSubMode("preview");
        } else if (data === KEY_ENTER) {
          const flows = architectWidget.getFlowContents();
          const idx = architectWidget.getSelectedFlowIndex();
          const selected = flows[idx];
          if (selected) {
            (async () => {
              await openArchitectFlowOverlay(selected.content);
            })();
          }
        }
        return { consume: true };
      }

      // Ctrl+O: open detail overlay or flow preview overlay
      if (data === KEY_CTRL_O && architectWidget && !architectOverlayOpen) {
        (async () => {
          architectOverlayOpen = true;
          try {
            if (architectWidget.hasFlowContent()) {
              const flows = architectWidget.getFlowContents();
              if (flows.length === 1) {
                await openArchitectFlowOverlay(flows[0].content);
              } else if (flows.length > 1) {
                architectWidget.setPreviewSubMode("navigate");
                architectOverlayOpen = false;
                return;
              }
            } else {
              const entries = architectWidget.getEventLog?.() || [];
              if (entries.length > 0) {
                await openDetailOverlay("flow-architect", "running", undefined, entries);
              }
            }
          } catch { /* overlay not available */ }
          finally { architectOverlayOpen = false; }
        })();
        return { consume: true };
      }
      return undefined;
    });
  }

  // Build resolveAgentType using discovered agents
  function getResolveAgentType(piRef: ExtensionAPI): ((name: string) => "built-in" | "local") {
    const agentsQuery: any = {};
    piRef.events.emit("flow:get-agents", agentsQuery);
    const discoveredAgentsMap: Map<string, any> = agentsQuery.agents ?? new Map();
    const piLocalPrefix = join(process.cwd(), ".pi");
    return (agentName: string): "built-in" | "local" => {
      const config = discoveredAgentsMap.get(agentName);
      if (config?.source && config.source.startsWith(piLocalPrefix)) return "local";
      return "built-in";
    };
  }

  // Architect lifecycle: started
  pi.events.on("flow:architect-started", async (data: unknown) => {
    if (!uiCtx) return;
    const resolveAgentType = getResolveAgentType(pi);
    await mountArchitectWidget(resolveAgentType);
    registerArchitectKeyboard(pi);
    // Set architect model info if provided
    const { resolvedModel, modelAlias } = (data || {}) as { resolvedModel?: string; modelAlias?: string };
    if (architectWidget && resolvedModel) {
      architectWidget.setModel(resolvedModel, modelAlias || "");
    }
  });

  // Architect lifecycle: tool call
  pi.events.on("flow:architect-tool-call", (data: unknown) => {
    if (!architectWidget) return;
    const { toolName, input } = data as { toolName: string; input: any };
    architectWidget.onToolCall(toolName, input);
    architectRender();
  });

  // Architect lifecycle: tool result
  pi.events.on("flow:architect-tool-result", (data: unknown) => {
    if (!architectWidget) return;
    const { toolName, output, isError } = data as { toolName: string; output: any; isError: boolean };
    architectWidget.onToolResult(toolName, output, isError);
    architectRender();
  });

  // Architect lifecycle: text
  pi.events.on("flow:architect-text", (data: unknown) => {
    if (!architectWidget) return;
    const { kind, text } = data as { kind: string; text: string };
    if (kind === "assistant") architectWidget.onAssistantText?.(text);
    else if (kind === "thinking") architectWidget.onThinkingText?.(text);
  });

  // Architect lifecycle: preview ready
  pi.events.on("flow:architect-preview", (_data: unknown) => {
    architectWidget?.setReady?.();
    architectRender();
  });

  // Architect lifecycle: complete
  pi.events.on("flow:architect-complete", (_data: unknown) => {
    unmountArchitectWidget();
  });

  // Architect lifecycle: error (architect failed but may retry)
  // Don't unmount — the orchestrator may offer retry prompt

  // Architect lifecycle: replan — reset widget for new iteration
  pi.events.on("flow:architect-replan", (_data: unknown) => {
    unmountArchitectWidget();
    // Widget will be re-mounted on next flow:architect-started
  });

  // Typed lifecycle events → TUI notifications
  pi.events.on("flow:architect-context-generating", (_data: unknown) => {
    uiCtx?.notify("Analyzing conversation...", "info");
  });

  pi.events.on("flow:architect-init-error", (data: unknown) => {
    const { reason } = data as { reason: string };
    if (reason === "agent-not-found") {
      uiCtx?.notify("Could not load flow-architect agent.", "error");
    } else if (reason === "already-running") {
      uiCtx?.notify("Architect already running.", "warning");
    } else if (reason === "no-flows") {
      uiCtx?.notify("No flows found to edit.", "info");
    } else {
      uiCtx?.notify(`Architect error: ${reason}`, "error");
    }
  });

  pi.events.on("flow:architect-cancelled", (_data: unknown) => {
    uiCtx?.notify("Cancelled.", "warning");
    unmountArchitectWidget();
  });

  pi.events.on("flow:architect-saved", (data: unknown) => {
    const d = data as { flowName: string; commandName?: string; mode?: string };
    if (d.mode === "edit") {
      uiCtx?.notify(`Flow "${d.flowName}" updated.`, "info");
    } else {
      uiCtx?.notify(`Flow saved as "${d.flowName}" — available as /${d.commandName || d.flowName}`, "info");
    }
  });

  pi.events.on("flow:architect-run-handoff", (data: unknown) => {
    const { flowName } = data as { flowName: string };
    uiCtx?.notify(`Running flow: "${flowName}"...`, "info");
  });

  pi.events.on("flow:architect-error", (data: unknown) => {
    const d = data as { phase?: string; error?: string; summary?: string };
    if (d.phase === "save") {
      uiCtx?.notify(`Failed to save flow: ${d.error}`, "error");
    }
    // Other errors (architect failure) don't need a separate notify —
    // the orchestrator will emit a prompt-request for retry/cancel
  });

  // Generic fallback notification
  pi.events.on("flow:notify", (data: unknown) => {
    const { message, level } = data as { message: string; level?: string };
    uiCtx?.notify(message, (level as any) || "info");
  });

  // ── Summary TUI rendering (driven by events from flow-summary) ──

  pi.events.on("flow:summary-ready", (data: any) => {
    if (!uiCtx) return;

    const { flowResult: fr, stats, hasIssue, nextStep, agentNames } = data;
    const statusIcon = hasIssue ? "⚠" : "✓";

    // Register lifecycle-scoped summary input handler
    registerSummaryInputHandler();

    setFlowWidget(uiCtx, "flow-summary", (_tui: any, theme: any) => {
      const text = new Text("", 0, 1);
      return {
        render(width: number): string[] {
          const state = getSummaryState();
          if (!state) return [];
          const inner = width - 4;

          // ── Navigate mode: agent list with card metrics ──
          if (state.mode === "navigate") {
            const bi = width - 4;
            const content: string[] = [];

            const navHeader = `${fr.flowName} · Select agent`;
            content.push(theme.fg("accent", navHeader));

            const lastCardsRef = getLastCards();
            const lastEventLogRef = getLastEventLog();

            for (let i = 0; i < agentNames.length; i++) {
              const name = agentNames[i];
              const result = fr.results[name];
              const sel = i === state.selectedIndex ? ">" : " ";
              const statusStr = result?.status || "unknown";
              const sIcon = statusStr === "complete" ? theme.fg("success", "✓")
                : statusStr === "skipped" ? theme.fg("dim", "✓")
                : statusStr === "blocked" ? theme.fg("warning", "⚠")
                : statusStr === "error" ? theme.fg("error", "⚠")
                : theme.fg("dim", "○");

              let metricStr = "";
              const card = lastCardsRef?.get(name);
              if (card) {
                const metric = card.renderer.renderMetric(Math.max(10, bi - name.length - 8));
                if (metric) metricStr = theme.fg("dim", "  " + metric.trim());
              } else {
                const eventCount = lastEventLogRef?.get(name)?.length ?? 0;
                if (eventCount > 0) metricStr = theme.fg("dim", ` · ${eventCount} events`);
              }

              content.push(`${sel} ${sIcon} ${name}${metricStr}`);
            }

            const lines = renderBox({
              width,
              theme,
              content,
              separatorAfter: [0],
              footer: [theme.fg("dim", "↑↓ navigate · Enter inspect · Backspace back")],
            });

            while (lines.length < state.summaryBoxHeight) lines.push("");
            state.summaryBoxHeight = Math.max(state.summaryBoxHeight, lines.length);

            text.setText(lines.join("\n"));
            return text.render(width);
          }

          // ── Summary box mode (default) ──
          const content: string[] = [];
          const separators: number[] = [];

          const header = `${statusIcon} ${fr.flowName} complete · ${stats.agentCount} agents · ${stats.duration}`;
          content.push(theme.fg("accent", header));
          separators.push(0);

          for (const agent of stats.perAgent) {
            const icon = agent.status === "complete" ? theme.fg("success", "✓")
              : agent.status === "skipped" ? theme.fg("dim", "✓")
              : agent.status === "blocked" ? theme.fg("warning", "⚠")
              : agent.status === "error" ? theme.fg("error", "⚠")
              : theme.fg("dim", "○");
            const detail = agent.fileCount > 0 ? ` (${agent.fileCount} files)` : "";
            content.push(`${icon} ${agent.name}${detail}`);
            // Show truncated finish summary if available
            const agentSummary = fr.results[agent.name]?.summary;
            if (agentSummary) {
              const maxLen = inner - 4;
              const trimmed = agentSummary.length > maxLen ? agentSummary.slice(0, maxLen - 1) + "…" : agentSummary;
              content.push(theme.fg("dim", `  ${trimmed}`));
            }
          }

          if (nextStep) {
            separators.push(content.length - 1);
            const nextLine = `Next: /${nextStep}`;
            content.push(theme.fg("warning", nextLine));
          }

          const lines = renderBox({
            width,
            theme,
            content,
            separatorAfter: separators,
            footer: [theme.fg("dim", "Ctrl+O inspect agents · Ctrl+X dismiss")],
          });

          state.summaryBoxHeight = lines.length;

          text.setText(lines.join("\n"));
          return text.render(width);
        },
        invalidate() { /* static content, no cleanup needed */ },
      };
    }, { placement: "aboveEditor" });
  });

  // ── Dashboard-initiated dismiss: clear TUI summary widget ──
  pi.events.on("flow:summary-dismissed", () => {
    if (!uiCtx) return;
    const state = getSummaryState();
    if (state) {
      setFlowWidget(uiCtx, "flow-summary", undefined);
      unregisterSummaryInputHandler();
      setSummaryState(null);
      requestRender();
    }
  });

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
        "  /roles              Assign model roles",
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
        pi.events.emit("flow:autonomous-mode-changed", { enabled: isAutonomousMode() });
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
