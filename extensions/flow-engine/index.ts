import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, Spacer, Text } from "@mariozechner/pi-tui";
import type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
} from "./types.js";
import { discoverAll, resolvePackageRoot } from "./discovery.js";
import { getModelRole, isAutonomousMode, setAutonomousMode } from "../provider-register.js";
import { getSummaryState, setSummaryState } from "../flow-summary/index.js";
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
import { FlowCancelledError } from "./flow-execution.js";
import { CheckboxSelectList } from "../shared/checkbox-select-list.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { GridComponent } from "../flow-dashboard/grid-component.js";
import { createAgentDetailOverlay } from "../flow-dashboard/agent-detail-overlay.js";
import { setFlowWidget } from "../shared/flow-widget.js";

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
export { runFlow, FlowCancelledError } from "./flow-execution.js";
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
const extraGuardFactories: any[] = []; // ExtensionFactory[]
const registeredExtensionTools: any[] = []; // Extension-registered tools for flow agent sessions

// ---- Ask-user bridge queue ------------------------------------------------
// Queues extension_ui_request events from parallel subagents and dispatches
// them one at a time to the main session UI.

interface AskUserQueueEntry {
  requestId: string;
  agentName: string;
  request: any;                 // The extension_ui_request event
  respond: (response: any) => void;  // Writes extension_ui_response to child stdin
}

class AskUserQueue {
  private queue: AskUserQueueEntry[] = [];
  private processing = false;
  private ui: any = null;
  private isOverlayOpen: () => boolean = () => false;
  private aborted = false;

  setUI(ui: any, isOverlayOpen: () => boolean) {
    this.ui = ui;
    this.isOverlayOpen = isOverlayOpen;
  }

  enqueue(entry: AskUserQueueEntry) {
    if (this.aborted) {
      entry.respond({ id: entry.requestId, cancelled: true });
      return;
    }
    this.queue.push(entry);
    this.processNext();
  }

  cancelAll() {
    this.aborted = true;
    for (const entry of this.queue) {
      entry.respond({ id: entry.requestId, cancelled: true });
    }
    this.queue = [];
  }

  reset() {
    this.queue = [];
    this.processing = false;
    this.aborted = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0 || !this.ui) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.aborted) {
      // Wait for any open overlay to close
      while (this.isOverlayOpen()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const entry = this.queue.shift()!;
      const { request, respond, agentName, requestId } = entry;
      const method = request.method;
      const pendingHint = this.queue.length > 0 ? ` (${this.queue.length} more pending)` : "";
      const decoratedTitle = `🤖 ${agentName} asks: ${request.title || request.message || ""}${pendingHint}`;

      try {
        if (method === "select") {
          const answer = await this.ui.select(decoratedTitle, request.options || []);
          if (answer === undefined) {
            respond({ id: requestId, cancelled: true });
          } else {
            respond({ id: requestId, value: answer });
          }
        } else if (method === "confirm") {
          const answer = await this.ui.confirm(decoratedTitle, request.message || "");
          respond({ id: requestId, confirmed: answer });
        } else if (method === "input") {
          const answer = await this.ui.input(decoratedTitle, request.placeholder || "");
          if (answer === undefined) {
            respond({ id: requestId, cancelled: true });
          } else {
            respond({ id: requestId, value: answer });
          }
        } else {
          // Unsupported method — cancel so child doesn't hang
          respond({ id: requestId, cancelled: true });
        }
      } catch {
        respond({ id: requestId, cancelled: true });
      }
    }

    this.processing = false;
  }
}

const askUserQueue = new AskUserQueue();

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
  getModelRole: () => ((role: string) => string | undefined) | undefined;
  getProjectRoot: () => string;
  getPkgRoot: () => string;
  getAuthStorage?: () => any;
  getModelRegistry?: () => any;
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
    askUserQueue.cancelAll();
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
    const { pi, getAgents, getModelRole, getProjectRoot, getPkgRoot } = this.deps;

    // Set up ask-user queue for this flow
    askUserQueue.reset();
    askUserQueue.setUI(ui, this.deps.isOverlayOpen);

    // Dynamic import to avoid circular deps
    const { runFlow: runFlowFn } = await import("./flow-execution.js");

    const promise = runFlowFn({
      flow,
      task,
      cwd: getProjectRoot(),
      authStorage: this.deps.getAuthStorage?.(),
      modelRegistry: this.deps.getModelRegistry?.(),
      extraGuardFactories: [...extraGuardFactories],
      extraCustomTools: [...registeredExtensionTools],
      signal: abortController.signal,
      isAutonomous: () => isAutonomousMode(),
      onAutoDecision: dashboard
        ? (forkId, agentName, chosenBranch, targetStepId) => {
            pi.events.emit("flow:auto-decision", { forkId, agentName, chosenBranch, targetStepId });
          }
        : undefined,
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

            const signal = abortController.signal;

            // ── Multi-select: checkbox overlay ──
            if (extra?.multiSelect && askOptions) {
              if (ui.custom) {
                const selected: string[] = await ui.custom((tui: any, t: any, _kb: any, done: (val: string[]) => void) => {
                    const checkboxItems: SelectItem[] = askOptions.map((opt) => ({
                      value: opt,
                      label: opt,
                    }));
                    const checkbox = new CheckboxSelectList(checkboxItems, Math.min(checkboxItems.length, 12), {
                      selectedPrefix: (text: string) => t.fg("accent", text),
                      selectedText: (text: string) => t.fg("accent", text),
                      description: (text: string) => t.fg("muted", text),
                      scrollInfo: (text: string) => t.fg("dim", text),
                      noMatch: (text: string) => t.fg("warning", text),
                    });
                    checkbox.onConfirm = (items: SelectItem[]) => done(items.map((s) => s.value));
                    checkbox.onCancel = () => done([]);

                    // Dismiss on abort signal (Ctrl+X)
                    const onAbort = () => done([]);
                    signal.addEventListener("abort", onAbort, { once: true });

                    const container = new Container();
                    container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
                    container.addChild(new Text(t.fg("accent", ` ${question}`), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(checkbox as any);
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(t.fg("dim", " Space: toggle  Enter: confirm  Esc: cancel"), 0, 0));
                    container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));

                    return {
                      render: (w: number) => container.render(w),
                      invalidate: () => container.invalidate(),
                      handleInput: (data: string) => {
                        checkbox.handleInput(data);
                        tui.requestRender();
                      },
                    };
                  });
                if (!selected || selected.length === 0) throw new FlowCancelledError();
                return { answer: selected as any };
              }
              // Fallback: per-option confirm if ui.custom not available
              const selected: string[] = [];
              for (const opt of askOptions) {
                const yes = await ui.confirm(
                  `${question}\n  Include "${opt}"?`,
                  "",
                  { signal },
                );
                if (yes) selected.push(opt);
              }
              return { answer: selected as any };
            }

            // ── Select ──
            if (type === "select" && askOptions) {
              const options = [...askOptions];
              if (extra?.allowCustom) options.push("Other (describe)");

              // Add auto-decide option if fork has an agent for autonomous mode
              const AUTO_DECIDE_OPTION = "🤖 Auto-decide (let AI choose)";
              if (extra?.hasAutoAgent && !isAutonomousMode()) {
                options.push(AUTO_DECIDE_OPTION);
              }

              // Append branch targets to option labels for transparency
              const branches = extra?.branches as Record<string, string> | undefined;
              const displayOptions = branches
                ? options.map(opt => {
                    const target = branches[opt];
                    return target ? `${opt} → ${target}` : opt;
                  })
                : options;

              const answer = await ui.select(question, displayOptions, { signal });
              if (answer === undefined) throw new FlowCancelledError();

              // Strip branch target suffix to get the real option value
              let finalAnswer = answer;
              if (branches) {
                // Find original option name by stripping " → target" suffix
                const originalOpt = options.find(opt => {
                  const target = branches[opt];
                  return target ? `${opt} → ${target}` === answer : opt === answer;
                });
                if (originalOpt) finalAnswer = originalOpt;
              }

              // Handle auto-decide: enable autonomous mode and return special signal
              if (finalAnswer === AUTO_DECIDE_OPTION) {
                setAutonomousMode(true);
                return { answer: "__auto_decide__" };
              }

              // Handle "Other (describe)" custom freetext
              if (extra?.allowCustom && finalAnswer === "Other (describe)") {
                const custom = await ui.input("Describe:", "", { signal });
                if (custom === undefined) throw new FlowCancelledError();
                finalAnswer = custom;
              }

              // Handle allowNotes
              let notes: string | undefined;
              if (extra?.allowNotes) {
                const notesInput = await ui.input("Optional notes (press Enter to skip):", "", { signal });
                if (notesInput === undefined) throw new FlowCancelledError();
                if (notesInput && notesInput.trim()) notes = notesInput.trim();
              }

              const result = notes !== undefined ? { answer: finalAnswer, notes } : { answer: finalAnswer };
              return result;
            }

            // ── Confirm ──
            if (type === "confirm") {
              const answer = await ui.confirm(question, "", { signal });
              return { answer: answer ? "yes" : "no" };
            }

            // ── Input (freetext) ──
            const answer = await ui.input(question, "", { signal });
            if (answer === undefined) throw new FlowCancelledError();
            return { answer: answer || "" };
          }
        : async (_question: string, _type: string, askOptions?: string[]) => {
            return { answer: askOptions?.[0] || "" };
          },
      onAgentStarted: (agentName: string) => {
          if (dashboard) {
            const config = getAgents().get(agentName);
            dashboard.onAgentStarted(agentName, config);
            renderDashboard!();
          }
        },
      onAgentComplete: dashboard
        ? (agentName: string, _stepId: string, result: any) => {
            dashboard.onAgentComplete(agentName, result);
            renderDashboard!();
          }
        : undefined,
      onExtensionUIRequest: (agentName: string, request: any, respond: (response: any) => void) => {
        askUserQueue.enqueue({
          requestId: request.id,
          agentName,
          request,
          respond,
        });
      },
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
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!wasAborted) {
          // Surface the error to the user — don't swallow silently
          ui?.notify?.(`Flow "${flowName}" failed: ${errMsg}`, "error");
        }
        // Emit flow:complete on failure/abort so listeners can clean up
        const summaryMsg = wasAborted ? "Aborted by user" : errMsg;
        const errorResult: FlowResult = {
          lastResult: {
            success: false,
            output: "",
            stderr: "",
            exitCode: null,
            result: { status: "error", files: [], summary: summaryMsg, artifacts: "" },
            toolCalls: [],
            duration: 0,
            tokens: { input: 0, output: 0 },
          },
          results: {},
          forks: {},
          flowName,
          stepCount: 0,
          totalDuration: 0,
          status: wasAborted ? "aborted" : "error",
        };
        pi.events.emit("flow:complete", errorResult);
      });
  }
}

// ---- Extension activation --------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const pkgRoot = resolvePackageRoot(import.meta.url);
  const projectRoot = process.cwd();
  packageRoot = pkgRoot;

  // Initial discovery
  init(pkgRoot, projectRoot);

  // Crash recovery: clean up orphaned staging directory from previous session
  {
    const stagingDir = join(projectRoot, ".pi", "flows", ".staging");
    if (existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // getModelRole is imported at top level — shared module instance via single entry point.

  // Track authStorage and modelRegistry from session context
  let sessionAuthStorage: any = undefined;
  let sessionModelRegistry: any = undefined;

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

  // Summary state — imported directly from flow-summary via single entry point.

  pi.on("session_start", (_event: any, ctx: any) => {
    uiCtx = ctx.ui;
    // Capture modelRegistry from session context; authStorage lives on modelRegistry
    if (ctx.modelRegistry) {
      sessionModelRegistry = ctx.modelRegistry;
      sessionAuthStorage = (ctx.modelRegistry as any).authStorage;
    }
    if (ctx.hasUI) {
      // Print help once at session start, not as a persistent widget
      const lines = [
        "  /flows              Manage flows (new, edit, delete)",
        "  /flows:new          Design & run a new flow",
        "  /flows:edit         Edit an existing flow",
        "  /flows:delete       Delete a flow",
        "  /provider           Manage LLM providers",
        "  /roles              Assign model roles",
        "  /catalog            Manage model catalog",
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
    // Ensure dashboard widget is removed (safety net if cleanup missed it)
    if (dashboardVisible || activeDashboard) {
      if (uiCtx) setFlowWidget(uiCtx, "flow-dashboard", undefined);
      dashboardVisible = false;
      activeDashboard = null;
    }
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
  const KEY_CTRL_A = "\x01";

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

    // ── Ctrl+X: always abort if a flow is running (even without dashboard focus) ──
    if (data === KEY_CTRL_X && flowManager.isRunning) {
      flowManager.abort();
      return { consume: true };
    }

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
        if (data === KEY_CTRL_A) {
          setAutonomousMode(!isAutonomousMode());
          requestRender();
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
        // Dismiss the summary widget entirely
        if (uiCtx) setFlowWidget(uiCtx, "flow-summary", undefined);
        summaryVisible = false;
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
      setFlowWidget(lastWiredUi, "flow-dashboard", undefined);
      lastWiredUi = null;
      // Force a full re-render so differential rendering doesn't leave stale header lines
      tui?.requestRender(true);
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

  // Unregister directory events — used for staging cleanup
  pi.events?.on("flow:unregister-agents-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    const idx = extraAgentsDirs.indexOf(dir);
    if (idx !== -1) {
      extraAgentsDirs.splice(idx, 1);
      init(pkgRoot, projectRoot);
    }
  });

  pi.events?.on("flow:unregister-flows-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    const idx = extraFlowsDirs.indexOf(dir);
    if (idx !== -1) {
      extraFlowsDirs.splice(idx, 1);
      init(pkgRoot, projectRoot);
    }
  });

  pi.events?.on("flow:register-skills-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir) registerExtraSkillsDir(dir);
  });

  // Guard extension registration: dependent packages register additional
  // guard extensions that are loaded into spawned subagent sessions.
  // Accepts { factory: ExtensionFactory } or { path: string } (backward compat).
  pi.events?.on("flow:register-guard-extension", (data) => {
    const entry = data as { factory?: any; path?: string };
    if (entry.factory) {
      extraGuardFactories.push(entry.factory);
    } else if (entry.path) {
      // Backward compat: wrap path-based registration as a factory
      const filePath = entry.path;
      const factory = async (piApi: any) => {
        const mod = await import(filePath);
        if (mod.default) mod.default(piApi);
      };
      extraGuardFactories.push(factory);
    }
  });

  // Register autonomous mode footer segment
  pi.events?.emit("flow:register-footer-segment", {
    name: "autonomous-mode",
    render: () => isAutonomousMode() ? "🤖 auto" : null,
  });

  // Register tools
  registerSubagentTool(
    pi,
    () => agents,
    (role) => getModelRole(role),
    projectRoot,
    () => sessionAuthStorage,
    () => sessionModelRegistry,
    () => [...extraGuardFactories],
  );

  registerAskUserTool(pi);
  registerSkillReadTool(pi, pkgRoot);

  // Architect tools — used by flow-architect agent during flow design.
  // We capture the tool definitions so they can be passed to architect subagent sessions
  // as customTools (since extension tools aren't available in SDK subagent sessions).
  const architectToolDefs: any[] = [];
  // Extension-registered tools populated via flow:register-tool events (module-level array)
  const capturingPi = {
    ...pi,
    registerTool: (tool: any) => {
      architectToolDefs.push(tool);
      pi.registerTool(tool);
    },
  };
  registerAgentCatalogTool(capturingPi as any, () => agents, projectRoot, pkgRoot, () => extraAgentsDirs);
  registerAgentValidateTool(capturingPi as any);
  registerAgentWriteTool(capturingPi as any);
  registerFlowValidateTool(capturingPi as any, () => agents);
  registerFlowWriteTool(capturingPi as any, () => agents);
  registerFlowPreviewTool(capturingPi as any, () => agents);

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
    summaryVisible = false;
    activeDashboard = dashboard;
    dashboardVisible = true;

    // Create a stable component once — avoid recreation on every spinner tick
    let tuiRef: any = null;
    let themeRef: any = null;
    let disposed = false;
    const component = {
      render(width: number): string[] {
        if (disposed) return [];
        const lines = dashboard.render(width, themeRef);
        // Prepend ANSI reset to every line to prevent background bleed from conversation tool output
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

    // Register widget — clears all other flow widgets automatically
    setFlowWidget(
      ui,
      "flow-dashboard",
      (tuiInstance: any, theme: any) => {
        tuiRef = tuiInstance;
        tui = tuiInstance; // store for requestRender in input routing
        themeRef = theme; // store for overlay rendering
        return component;
      },
    );

    // Force full re-render to clear stale lines from any previous widget
    // (e.g., architect widget's Flow Preview box). nextTick ensures tuiRef is set.
    process.nextTick(() => { tuiRef?.requestRender(true); });

    // Spinner callback: invalidate + request render (no setWidget recreation)
    const update = () => {
      if (disposed) return;
      component.invalidate();
      // Force full TUI re-render when grid structure changed (new unpreloaded agent)
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

  // ── Initialize FlowManager ──
  flowManager = new FlowManager({
    pi,
    getAgents: () => agents,
    getModelRole: () => getModelRole,
    getProjectRoot: () => projectRoot,
    getPkgRoot: () => pkgRoot,
    getAuthStorage: () => sessionAuthStorage,
    getModelRegistry: () => sessionModelRegistry,
    extractAgentConfigs,
    buildAgentDeps,
    wireDashboard,
    isOverlayOpen: () => overlayOpen,
    onFlowCleanup: (activeFlow: ActiveFlow) => {
      askUserQueue.reset();
      if (activeFlow.dashboard) {
        lastToolHistory = new Map(activeFlow.dashboard.getAllToolHistory());
        lastCards = new Map(activeFlow.dashboard.getAllCards());
        activeFlow.dashboard.dispose();
        if (activeFlow.ui) setFlowWidget(activeFlow.ui, "flow-dashboard", undefined);
        dashboardVisible = false;
        activeDashboard = null;
        // Force a full re-render so differential rendering doesn't leave stale header lines
        tui?.requestRender(true);
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

        // Prompt for task if required and no args provided
        let task = args || "";
        if (flow.task_required && !task.trim()) {
          const prompt = flow.task_prompt || `Describe what you want ${name} to do:`;
          const answer = await ctx.ui.input(prompt, "");
          if (!answer?.trim()) return; // cancelled or empty — don't launch
          task = answer.trim();
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
          task,
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

  // Provide architect tool definitions for subagent sessions (flow-workspace)
  pi.events.on("flow:get-architect-tools", (data: any) => {
    data.tools = architectToolDefs;
  });

  // Allow extensions to register custom tool definitions for use in flow agent sessions.
  // Extensions emit: pi.events.emit("flow:register-tool", { tool: toolDefinition })
  // Collected tools are passed as extraCustomTools to all spawnAgent() calls in flow-execution.ts,
  // filtered to only agents that declare the tool name in their frontmatter tools: list.
  pi.events.on("flow:register-tool", (data: any) => {
    if (data?.tool) {
      registeredExtensionTools.push(data.tool);
    }
  });

  // Provide authStorage/modelRegistry for subagent sessions (flow-workspace)
  pi.events.on("flow:get-spawn-context", (data: any) => {
    data.authStorage = sessionAuthStorage;
    data.modelRegistry = sessionModelRegistry;
    data.extraGuardFactories = [...extraGuardFactories];
  });
}
