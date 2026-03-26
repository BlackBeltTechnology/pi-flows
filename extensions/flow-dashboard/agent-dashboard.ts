import type { WorkflowDefinition } from "./types.js";
import type { AgentResult, AgentConfig } from "../flow-engine/types.js";
import { AgentCard } from "./agent-card.js";
import { GridComponent, CARD_HEIGHT, MIN_CARD_WIDTH } from "./grid-component.js";
import { renderBreadcrumb } from "./breadcrumb.js";
import { getCardRenderer } from "./card-registry.js";

export type DashboardMode = "passive" | "navigate";

// Legacy type kept for backward compatibility with external consumers
export interface ToolHistoryEntry {
  toolName: string;
  input: any;
  output: any;
  isError: boolean;
}

export type DetailEntry =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolName: string; input: any; output: any; isError: boolean }
  | { kind: "error"; text: string };

export class AgentDashboard {
  private grid = new GridComponent();
  private cards = new Map<string, AgentCard>();
  private eventLog = new Map<string, DetailEntry[]>();
  private currentStageIndex: number;
  private stageDetail = "";
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private onUpdate?: () => void;

  // Height stabilization: track expected grid rows to keep widget height constant
  private expectedGridRows = 0;

  // Flag to signal that grid structure changed (new card added) and a full TUI re-render is needed
  public forceNextRender = false;

  // Interactive state machine
  mode: DashboardMode = "passive";
  selectedCardIndex = 0;

  constructor(
    private workflow: WorkflowDefinition | null,
    stageIndex: number,
    private theme?: any
  ) {
    this.currentStageIndex = stageIndex;
  }

  /** Set callback for animation-driven re-renders. */
  setUpdateCallback(cb: () => void): void {
    this.onUpdate = cb;
  }

  preloadAgents(agents: AgentConfig[], agentDeps?: Map<string, string[]>): void {
    for (const config of agents) {
      const name = config.name;
      if (!this.cards.has(name)) {
        const renderer = getCardRenderer(config);
        const card = new AgentCard(name, "pending", renderer);
        card.modelRole = config.model || "";
        card.cardRole = config.card?.role || "";
        card.label = config.card?.label || "";
        if (agentDeps?.has(name)) {
          card.blockedByNames = agentDeps.get(name)!;
        }
        this.cards.set(name, card);
      }
    }
    this.syncGrid();
    // Compute expected grid rows based on current card count (use a reasonable default width)
    this.updateExpectedGridRows();
  }

  private updateExpectedGridRows(): void {
    const cardCount = this.cards.size;
    if (cardCount === 0) {
      this.expectedGridRows = 0;
      return;
    }
    // Use MIN_CARD_WIDTH * 4 as a reasonable width estimate for row computation
    // The actual rows will be recomputed on first render with real width
    const estimatedWidth = MIN_CARD_WIDTH * 4 + 3; // 4 cols + 3 gaps
    const cols = GridComponent.computeCols(cardCount, estimatedWidth);
    this.expectedGridRows = Math.ceil(cardCount / cols);
  }

  onAgentStarted(agentName: string, agentConfig?: AgentConfig): void {
    if (!this.eventLog.has(agentName)) this.eventLog.set(agentName, []);
    let card = this.cards.get(agentName);
    if (!card) {
      // New card not previously preloaded — grid structure will change
      const renderer = getCardRenderer(agentConfig);
      card = new AgentCard(agentName, "running", renderer);
      card.modelRole = agentConfig?.model || "";
      card.cardRole = agentConfig?.card?.role || "";
      card.label = agentConfig?.card?.label || "";
      this.cards.set(agentName, card);
      // Recompute expected rows and flag for full TUI re-render
      this.updateExpectedGridRows();
      this.forceNextRender = true;
    } else {
      card.status = "running";
      if (agentConfig?.model) card.modelRole = agentConfig.model;
    }
    this.syncGrid();
    this.startSpinner();
  }

  onAgentComplete(agentName: string, result: AgentResult): void {
    const card = this.cards.get(agentName);
    if (card) {
      card.status = result.success ? "complete" : "error";
      card.onComplete(result);
      card.renderer.onComplete(result);
    }
    // Capture error as an event log entry when agent failed
    if (!result.success) {
      const errorText = result.result?.summary || result.output || "Agent failed";
      if (!this.eventLog.has(agentName)) this.eventLog.set(agentName, []);
      this.eventLog.get(agentName)!.push({ kind: "error", text: errorText });
    }
    this.syncGrid();
    const anyRunning = Array.from(this.cards.values()).some(c => c.status === "running");
    if (!anyRunning) this.stopSpinner();
  }

  onToolCall(agentName: string, toolName: string, input: any): void {
    const card = this.cards.get(agentName);
    if (card) {
      card.onToolCall(toolName, input);
      card.renderer.onToolCall(toolName, input);
    }
    // Append tool entry to event log
    if (!this.eventLog.has(agentName)) this.eventLog.set(agentName, []);
    this.eventLog.get(agentName)!.push({ kind: "tool", toolName, input, output: undefined, isError: false });
  }

  onToolResult(agentName: string, toolName: string, output: any, isError?: boolean): void {
    this.cards.get(agentName)?.renderer.onToolResult(toolName, output);
    // Update last tool entry in event log
    const log = this.eventLog.get(agentName);
    if (log) {
      for (let i = log.length - 1; i >= 0; i--) {
        const entry = log[i];
        if (entry.kind === "tool" && entry.output === undefined) {
          entry.output = output;
          entry.isError = isError ?? false;
          break;
        }
      }
    }
  }

  onAssistantText(agentName: string, text: string): void {
    if (!text) return;
    if (!this.eventLog.has(agentName)) this.eventLog.set(agentName, []);
    this.eventLog.get(agentName)!.push({ kind: "text", text });
  }

  onThinkingText(agentName: string, text: string): void {
    if (!text) return;
    if (!this.eventLog.has(agentName)) this.eventLog.set(agentName, []);
    this.eventLog.get(agentName)!.push({ kind: "thinking", text });
  }

  getEventLog(agentName: string): DetailEntry[] {
    return this.eventLog.get(agentName) || [];
  }

  /** Legacy alias — returns tool entries only (for backward compat). */
  getToolHistory(agentName: string): ToolHistoryEntry[] {
    const log = this.eventLog.get(agentName) || [];
    return log.filter((e): e is DetailEntry & { kind: "tool" } => e.kind === "tool");
  }

  /** Return the full event log map (for snapshotting before dispose). */
  getAllToolHistory(): Map<string, DetailEntry[]> {
    return this.eventLog;
  }

  getAgentNames(): string[] {
    return Array.from(this.cards.keys());
  }

  /** Return all cards map (for snapshotting before dispose). */
  getAllCards(): Map<string, AgentCard> {
    return this.cards;
  }

  getCard(agentName: string): AgentCard | undefined {
    return this.cards.get(agentName);
  }

  setStageDetail(detail: string): void { this.stageDetail = detail; }

  private syncGrid(): void {
    this.grid.setCards(Array.from(this.cards.values()));
  }

  private startSpinner(): void {
    if (this.spinTimer) return;
    this.spinTimer = setInterval(() => {
      for (const card of this.cards.values()) {
        if (card.status === "running") card.spinFrame++;
      }
      this.onUpdate?.();
    }, 120);
  }

  private stopSpinner(): void {
    if (this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
  }

  render(width: number, theme?: any): string[] {
    const t = theme || this.theme;
    this.grid.setTheme(t);

    // Navigate mode: pass selection to grid
    if (this.mode === "navigate") {
      this.grid.setSelectedIndex(this.selectedCardIndex);
    } else {
      this.grid.setSelectedIndex(-1);
    }

    const lines: string[] = [];

    // Header: flow name + finished/total agents
    if (this.workflow) {
      const stage = this.workflow.stages[this.currentStageIndex];
      const total = this.cards.size;
      const finished = Array.from(this.cards.values()).filter(c => c.status === "complete" || c.status === "error").length;
      const title = t?.fg?.("accent", `  π ${stage?.name || this.workflow.id}`) ?? `  π ${stage?.name || this.workflow.id}`;
      const counts = t?.fg?.("dim", `  ${finished}/${total} agents`) ?? `  ${finished}/${total} agents`;
      lines.push(title + counts);
    }

    // Breadcrumb: only show if workflow has more than 1 stage
    if (this.workflow && this.workflow.stages.length > 1) {
      const bc = renderBreadcrumb(this.workflow, this.currentStageIndex, this.stageDetail, width, t);
      lines.push(bc);
    }

    const gridLines = this.grid.render(width);
    lines.push(...gridLines);

    // Stabilize height: compute expected grid output lines and pad if grid produced fewer
    // Grid output = 1 (padding before) + gridRows * CARD_HEIGHT + 1 (padding after)
    // Update expectedGridRows with actual width on first render
    if (this.cards.size > 0) {
      const cols = GridComponent.computeCols(this.cards.size, width);
      const actualRows = Math.ceil(this.cards.size / cols);
      if (actualRows > this.expectedGridRows) {
        this.expectedGridRows = actualRows;
      }
      const expectedGridLines = 1 + this.expectedGridRows * CARD_HEIGHT + 1; // padding + rows + padding
      while (lines.length < (this.workflow ? 1 : 0) +
             (this.workflow && this.workflow.stages.length > 1 ? 1 : 0) +
             expectedGridLines) {
        lines.push("");
      }
    }

    // Footer hints
    if (this.mode === "navigate") {
      lines.push(t?.fg?.("dim", "  ← → ↑ ↓ navigate · Enter open · Ctrl+X stop · ESC close") ?? "  ← → ↑ ↓ navigate · Enter open · Ctrl+X stop · ESC close");
    } else {
      lines.push(t?.fg?.("dim", "  Ctrl+O inspect · Ctrl+A auto-decide · Ctrl+X stop flow") ?? "  Ctrl+O inspect · Ctrl+A auto-decide · Ctrl+X stop flow");
    }

    return lines;
  }

  /** Compute the grid's rendered height for a given width (for matching detail view). */
  computeGridHeight(width: number): number {
    const cardCount = this.cards.size;
    if (cardCount === 0) return 10;
    const cols = GridComponent.computeCols(cardCount, width);
    const gridRows = Math.ceil(cardCount / cols);
    let height = gridRows * CARD_HEIGHT + 2; // +2 for grid padding lines (before + after)
    // Account for header + breadcrumb lines
    if (this.workflow) height++; // header
    if (this.workflow && this.workflow.stages.length > 1) height++;
    // Add navigate footer line
    height++;
    return Math.max(height, 10);
  }

  dispose(): void {
    this.stopSpinner();
  }

  invalidate(): void { /* grid no longer caches — re-renders fresh each call */ }
}
