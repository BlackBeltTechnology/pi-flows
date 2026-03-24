import type { WorkflowDefinition } from "./types.js";
import type { AgentResult, AgentConfig } from "../flow-engine/types.js";
import { AgentCard } from "./agent-card.js";
import { GridComponent, CARD_HEIGHT } from "./grid-component.js";
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
  | { kind: "tool"; toolName: string; input: any; output: any; isError: boolean };

export class AgentDashboard {
  private grid = new GridComponent();
  private cards = new Map<string, AgentCard>();
  private eventLog = new Map<string, DetailEntry[]>();
  private currentStageIndex: number;
  private stageDetail = "";
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private onUpdate?: () => void;

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
  }

  onAgentStarted(agentName: string, agentConfig?: AgentConfig): void {
    if (!this.eventLog.has(agentName)) this.eventLog.set(agentName, []);
    let card = this.cards.get(agentName);
    if (!card) {
      const renderer = getCardRenderer(agentConfig);
      card = new AgentCard(agentName, "running", renderer);
      card.modelRole = agentConfig?.model || "";
      card.cardRole = agentConfig?.card?.role || "";
      card.label = agentConfig?.card?.label || "";
      this.cards.set(agentName, card);
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

    lines.push(...this.grid.render(width));

    // Footer hints
    if (this.mode === "navigate") {
      lines.push(t?.fg?.("dim", "  ←→↑↓ navigate · Enter open · Ctrl+X stop · ESC close") ?? "  ←→↑↓ navigate · Enter open · Ctrl+X stop · ESC close");
    } else {
      lines.push(t?.fg?.("dim", "  Ctrl+O inspect · Ctrl+X stop flow") ?? "  Ctrl+O inspect · Ctrl+X stop flow");
    }

    return lines;
  }

  /** Compute the grid's rendered height for a given width (for matching detail view). */
  computeGridHeight(width: number): number {
    const cardCount = this.cards.size;
    if (cardCount === 0) return 10;
    const cols = GridComponent.computeCols(cardCount, width);
    const gridRows = Math.ceil(cardCount / cols);
    let height = gridRows * CARD_HEIGHT;
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

  invalidate(): void { this.grid.invalidate(); }
}
