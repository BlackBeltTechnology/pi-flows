// ---------------------------------------------------------------------------
// Flow TUI — Dashboard rendering, keyboard handling, and TUI observers
//
// All TUI-specific rendering and interaction code extracted from index.ts.
// Exports setupFlowTui() which wires everything into the extension lifecycle.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentConfig,
  AgentResult,
  FlowConfig,
  FlowResult,
} from "./types.js";
import type { FlowObserver } from "./flow-io.js";
import { FlowEventPersister, type OrphanedRun } from "./flow-persist.js";
import type { FlowManager } from "./flow-manager.js";
import { GridComponent } from "../flow-dashboard/grid-component.js";
import { createAgentDetailOverlay } from "../flow-dashboard/agent-detail-overlay.js";
import { setFlowWidget } from "../shared/flow-widget.js";
import {
  getSummaryState,
  setSummaryState,
  getLastEventLog,
  getLastCards,
} from "../flow-summary/index.js";
import { Text, Key } from "@earendil-works/pi-tui";
import { renderBox } from "../flow-dashboard/box-renderer.js";
import { isAutonomousMode, setAutonomousMode } from "../autonomous-mode.js";

// ---- Module-scoped state ---------------------------------------------------

let activeDashboard: any = null;
let lastToolHistory: Map<string, any[]> | null = null;
let lastCards: Map<string, any> | null = null;
let uiCtx: any = null;
let tui: any = null;
let overlayOpen = false;
let overlayDone: ((result: null) => void) | null = null;
let piRef: ExtensionAPI | null = null;

// Invalidator for the AUTO footer segment, set when the segment registers at
// session_start. Hoisted to module scope so the keybinding handler (registered
// once in setupFlowTui) can repaint the footer on toggle.
let invalidateAutoFooter: (() => void) | null = null;

// Lifecycle-scoped input handler unsubscribers
let unsubDashboardInput: (() => void) | null = null;
let unsubSummaryInput: (() => void) | null = null;

// ---- Key constants ---------------------------------------------------------

const KEY_ESC = "\x1b";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KEY_ENTER = "\r";
const KEY_BACKSPACE_1 = "\x7f";
const KEY_BACKSPACE_2 = "\b";

// ---- Helpers ---------------------------------------------------------------

function requestRender() {
  tui?.requestRender();
}

// Toggle flow autonomous (AUTO) mode and repaint affected UI.
function toggleAutonomousMode(pi: ExtensionAPI): void {
  setAutonomousMode(!isAutonomousMode());
  pi.events.emit("flow:autonomous-mode-changed", { enabled: isAutonomousMode() });
  requestRender();
  invalidateAutoFooter?.();
}

// Global flow.abort (alt+x): abort a running flow, else dismiss a mounted
// summary widget. No-op when neither is active, so the key falls through.
function abortOrDismiss(flowManager: FlowManager): void {
  if (flowManager.isRunning) {
    flowManager.abort();
    if (activeDashboard) {
      activeDashboard.mode = "passive";
      requestRender();
    }
    return;
  }
  const state = getSummaryState();
  if (state && uiCtx) {
    setFlowWidget(uiCtx, "flow-summary", undefined);
    unregisterSummaryInputHandler();
    setSummaryState(null);
    requestRender();
    piRef?.events?.emit("flow:summary-dismissed", {});
  }
}

// Global flow.inspect (alt+o): toggle navigate mode on whichever flow surface
// is mounted (dashboard ⇄ passive, or summary ⇄ navigate). No-op otherwise.
function toggleInspect(): void {
  if (activeDashboard) {
    const db = activeDashboard;
    if (db.mode === "navigate") {
      db.mode = "passive";
    } else {
      db.mode = "navigate";
      db.selectedCardIndex = 0;
    }
    requestRender();
    return;
  }
  const state = getSummaryState();
  if (state) {
    if (state.mode === "navigate") {
      state.mode = "summary";
    } else {
      state.mode = "navigate";
      state.selectedIndex = 0;
    }
    requestRender();
  }
}

async function openDetailOverlay(
  agentName: string,
  status: string,
  summary: string | undefined,
  entries: any[],
) {
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
function registerDashboardInputHandler(): () => void {
  if (!uiCtx) return () => {};

  // Unsubscribe any stale summary handler — dashboard replaces summary
  unregisterSummaryInputHandler();

  const unsub = uiCtx.onTerminalInput((data: string) => {
    if (overlayOpen) return undefined;

    if (!activeDashboard) return undefined;

    const db = activeDashboard;
    const mode = db.mode;

    // passive mode: alt+o (flow.inspect) / alt+x (flow.abort) are handled by
    // registered shortcuts; raw input passes through to the editor.
    if (mode === "passive") {
      return undefined;
    }

    if (mode === "navigate") {
      if (data === KEY_ESC) {
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
          openDetailOverlay(
            name,
            card?.status || "unknown",
            undefined,
            entries,
          );
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

    // summary mode: alt+o (flow.inspect) / alt+x (flow.abort) are handled by
    // registered shortcuts; raw input passes through to the editor.
    if (mode === "summary") {
      return undefined;
    }

    if (mode === "navigate") {
      if (
        data === KEY_ESC ||
        data === KEY_BACKSPACE_1 ||
        data === KEY_BACKSPACE_2
      ) {
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
          openDetailOverlay(
            name,
            result?.status || "unknown",
            result?.summary,
            entries,
          );
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
 */
export function unregisterSummaryInputHandler(): void {
  if (unsubSummaryInput) {
    unsubSummaryInput();
    unsubSummaryInput = null;
  }
}

// ---- wireDashboard ---------------------------------------------------------

function wireDashboard(dashboard: any, ui: any) {
  // Unregister stale summary handler and register dashboard handler
  unregisterSummaryInputHandler();
  activeDashboard = dashboard;
  registerDashboardInputHandler();

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

  setFlowWidget(ui, "flow-dashboard", (tuiInstance: any, theme: any) => {
    tuiRef = tuiInstance;
    tui = tuiInstance;
    themeRef = theme;
    return component;
  });

  process.nextTick(() => {
    tuiRef?.requestRender(true);
  });

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

  async onFlowStarted(
    flowName: string,
    flow: FlowConfig,
    _task: string,
  ): Promise<void> {
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
      this.renderDashboard = wireDashboard(this.dashboard, uiCtx);
      this.renderDashboard();
    } catch {
      /* flow-dashboard not available */
    }
  }

  onAgentStarted(
    agentName: string,
    _stepId: string,
    config?: AgentConfig,
    resolvedModel?: string,
  ): void {
    if (this.dashboard) {
      this.dashboard.onAgentStarted(agentName, config, resolvedModel);
      this.renderDashboard!();
    }
  }

  onAgentComplete(
    agentName: string,
    _stepId: string,
    result: AgentResult,
  ): void {
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

  onToolCall(
    agentName: string,
    _stepId: string,
    toolName: string,
    input: any,
  ): void {
    if (this.dashboard) {
      this.dashboard.onToolCall(agentName, toolName, input);
      this.renderDashboard!();
    }
  }

  onToolResult(
    agentName: string,
    _stepId: string,
    toolName: string,
    output: any,
    isError: boolean,
  ): void {
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

  onLoopIteration(
    stepId: string,
    iteration: number,
    maxIterations: number,
    loopTarget?: string,
  ): void {
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
  private persister: FlowEventPersister;

  constructor(private pi: ExtensionAPI, getSessionManager?: () => any) {
    this.persister = new FlowEventPersister(pi, getSessionManager);
  }

  // Emit the event live AND durably record it (best-effort) so the run
  // survives /resume and dashboard reload. See flow-persist.ts.
  private emit(channel: string, data: any): void {
    this.pi.events.emit(channel, data);
    this.persister.persist(channel, data);
  }

  onFlowStarted(flowName: string, flow: FlowConfig, task: string): void {
    // Serialize minimal step metadata for external consumers (dashboards, etc.)
    // Avoids sending full AgentConfig.systemPrompt (can be very large)
    const steps = flow.steps.map((step) => ({
      id: step.id,
      stepType: step.stepType,
      agent: (step as any).agent,
      blockedBy: (step as any).blockedBy || [],
      // Loop edges are now derived from backward branch targets in `branches:`
      // (the agent-loop-decision type is removed); decision branches are sent so
      // consumers can detect loops topologically.
      branches: (step as any).branches,
    }));
    this.emit("flow:flow-started", {
      flowName,
      task,
      steps,
      description: flow.description,
      maxConcurrent: flow.max_concurrent,
      autonomousMode: isAutonomousMode(),
      source: flow.source,
    });
    // Open the flush gate at START so the session file exists for the whole
    // run — mid-run stop+resume reattaches under the same id, and a mid-run
    // reload survives. (Completion marker still fires in onFlowComplete.)
    this.persister.emitStartMarker(flowName);
  }

  onAgentStarted(
    agentName: string,
    stepId: string,
    config?: AgentConfig,
    resolvedModel?: string,
  ): void {
    this.emit("flow:agent-started", {
      agentName,
      stepId,
      resolvedModel,
      config: config
        ? {
            name: config.name,
            description: config.description,
            model: config.model,
            card: config.card,
            sourcePath: config.source,
          }
        : undefined,
    });
  }

  onAgentComplete(
    agentName: string,
    stepId: string,
    result: AgentResult,
  ): void {
    this.emit("flow:agent-complete", {
      agentName,
      stepId,
      result: {
        success: result.success,
        status: result.result?.status,
        summary: result.result?.summary,
        files: result.result?.files?.map((f) => f.path) || [],
        tokens: result.tokens,
        duration: result.duration,
      },
    });
  }

  onAssistantText(agentName: string, stepId: string, text: string): void {
    this.emit("flow:assistant-text", { agentName, stepId, text });
  }

  onThinkingText(agentName: string, stepId: string, text: string): void {
    this.emit("flow:thinking-text", { agentName, stepId, text });
  }

  onToolCall(
    agentName: string,
    stepId: string,
    toolName: string,
    input: any,
  ): void {
    this.emit("flow:subagent-tool-call", {
      agentName,
      stepId,
      toolName,
      input,
    });
  }

  onToolResult(
    agentName: string,
    stepId: string,
    toolName: string,
    output: any,
    isError: boolean,
  ): void {
    this.emit("flow:subagent-tool-result", {
      agentName,
      stepId,
      toolName,
      output,
      isError,
    });
  }

  onAutoDecision(
    forkId: string,
    agentName: string,
    chosenBranch: string,
    targetStepId: string,
  ): void {
    this.emit("flow:auto-decision", {
      forkId,
      agentName,
      chosenBranch,
      targetStepId,
    });
  }

  onLoopIteration(
    stepId: string,
    iteration: number,
    maxIterations: number,
    loopTarget?: string,
  ): void {
    this.emit("flow:loop-iteration", {
      stepId,
      iteration,
      maxIterations,
      loopTarget,
    });
  }

  onFlowComplete(flowName: string, result: FlowResult): void {
    // Persist the completion event first (buffered if the gate is closed)…
    this.emit("flow:complete", result);
    // …then append the non-empty marker that opens the sticky flush gate, so
    // the whole buffered flow-event stream is written to disk for /resume.
    this.persister.emitCompletionMarker(flowName);
  }

  onError(agentName: string, stepId: string, text: string): void {
    this.emit("flow:agent-error", { agentName, stepId, text });
  }

  // Drive an orphaned flow run (one with no terminal record) to a terminal
  // state: emit `flow:complete` live so connected clients clear immediately,
  // and persist a `flow_complete` record tagged with the ORPHANED run's
  // flowRunId so the next cold resume is idempotent. seq is seeded past the
  // run's mid-run events so the terminal record replays last.
  //
  // NOT routed through `this.emit`: that would persist with the channel-driven
  // flowRunId (empty on a resumed persister) — we need the orphan's id.
  reconcileOrphanedRun(orphan: OrphanedRun, reason: "session-close" | "user-abort"): void {
    this.persister.seedSeq(orphan.maxSeq);
    const summary = reason === "session-close"
      ? "Flow interrupted \u2014 parent session closed"
      : "Flow aborted (no live run)";
    const result: FlowResult = {
      lastResult: {
        success: false,
        output: "",
        stderr: "",
        exitCode: null,
        result: { status: "error", files: [], summary, artifacts: "" },
        toolCalls: [],
        duration: 0,
        tokens: { input: 0, output: 0 },
      },
      results: {},
      forks: {},
      flowName: orphan.flowName,
      stepCount: 0,
      totalDuration: 0,
      status: "aborted",
    };
    this.pi.events.emit("flow:complete", result);
    this.persister.persistTerminal(orphan.flowRunId, result);
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
export function setupFlowTui(pi: ExtensionAPI, flowManager: FlowManager): void {
  piRef = pi;

  // Global flow keybindings live in the alt+<letter> namespace. They are
  // registered through the keybinding manager (NOT raw terminal input) so they
  // are user-rebindable and parsed consistently across terminals, and so they
  // do not collide with pi-ai's ctrl+<letter> editor/app defaults
  // (e.g. ctrl+o app.tools.expand, ctrl+t app.thinking.toggle, ctrl+a
  // tui.editor.cursorLineStart). alt+a/o/x are unbound in pi defaults.
  pi.registerShortcut(Key.alt("a"), {
    description: "Toggle flow autonomous (AUTO) mode",
    handler: () => toggleAutonomousMode(pi),
  });
  pi.registerShortcut(Key.alt("x"), {
    description: "Abort running flow / dismiss flow summary",
    handler: () => abortOrDismiss(flowManager),
  });
  pi.registerShortcut(Key.alt("o"), {
    description: "Inspect flow agents (toggle navigate mode)",
    handler: () => toggleInspect(),
  });

  // ── Legacy prompt request/response handler REMOVED ──
  // Previously listened for flow:prompt-request and presented via proxied uiCtx,
  // causing duplicate prompts on the dashboard. Now handled by TuiPromptAdapter
  // registered with the PromptBus (see tui-prompt-adapter.ts).

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

    setFlowWidget(
      uiCtx,
      "flow-summary",
      (_tui: any, theme: any) => {
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
                const sIcon =
                  statusStr === "complete"
                    ? theme.fg("success", "✓")
                    : statusStr === "skipped"
                      ? theme.fg("dim", "✓")
                      : statusStr === "blocked"
                        ? theme.fg("warning", "⚠")
                        : statusStr === "error"
                          ? theme.fg("error", "⚠")
                          : theme.fg("dim", "○");

                let metricStr = "";
                const card = lastCardsRef?.get(name);
                if (card) {
                  const metric = card.renderer.renderMetric(
                    Math.max(10, bi - name.length - 8),
                  );
                  if (metric) metricStr = theme.fg("dim", "  " + metric.trim());
                } else {
                  const eventCount = lastEventLogRef?.get(name)?.length ?? 0;
                  if (eventCount > 0)
                    metricStr = theme.fg("dim", ` · ${eventCount} events`);
                }

                content.push(`${sel} ${sIcon} ${name}${metricStr}`);
              }

              const lines = renderBox({
                width,
                theme,
                content,
                separatorAfter: [0],
                footer: [
                  theme.fg(
                    "dim",
                    "↑↓ navigate · Enter inspect · Backspace back",
                  ),
                ],
              });

              while (lines.length < state.summaryBoxHeight) lines.push("");
              state.summaryBoxHeight = Math.max(
                state.summaryBoxHeight,
                lines.length,
              );

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
              const icon =
                agent.status === "complete"
                  ? theme.fg("success", "✓")
                  : agent.status === "skipped"
                    ? theme.fg("dim", "✓")
                    : agent.status === "blocked"
                      ? theme.fg("warning", "⚠")
                      : agent.status === "error"
                        ? theme.fg("error", "⚠")
                        : theme.fg("dim", "○");
              const detail =
                agent.fileCount > 0 ? ` (${agent.fileCount} files)` : "";
              content.push(`${icon} ${agent.name}${detail}`);
              // Show truncated finish summary if available
              const agentSummary = fr.results[agent.name]?.summary;
              if (agentSummary) {
                const maxLen = inner - 4;
                const trimmed =
                  agentSummary.length > maxLen
                    ? agentSummary.slice(0, maxLen - 1) + "…"
                    : agentSummary;
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
              footer: [
                theme.fg("dim", "alt+o inspect agents · alt+x dismiss"),
              ],
            });

            state.summaryBoxHeight = lines.length;

            text.setText(lines.join("\n"));
            return text.render(width);
          },
          invalidate() {
            /* static content, no cleanup needed */
          },
        };
      },
      { placement: "aboveEditor" },
    );
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
    // after flow-footer's activate() has registered the event listener).
    // invalidateAutoFooter is module-scoped so the AUTO keybinding (registered
    // in setupFlowTui) can repaint this segment.
    pi.events?.emit("flow:register-footer-segment", {
      name: "autonomous-mode",
      render: (theme?: any) => {
        const label = "AUTO";
        if (!theme?.fg) return isAutonomousMode() ? label : null;
        return isAutonomousMode()
          ? theme.fg("accent", label)
          : theme.fg("dim", label);
      },
      onRegistered: (invalidate: () => void) => {
        invalidateAutoFooter = invalidate;
      },
    });
    // Abort (alt+x) and inspect (alt+o) are registered as keybinding-manager
    // shortcuts in setupFlowTui; modal navigation (arrows/Enter/Esc/Backspace)
    // is captured by the dashboard/summary input handlers, which are
    // registered/unregistered with their widget lifecycles.
  });
}
