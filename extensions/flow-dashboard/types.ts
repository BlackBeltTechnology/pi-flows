// ---------------------------------------------------------------------------
// Flow Dashboard -- Type Definitions
//
// Generic grid-based TUI dashboard for any workflow pipeline.
// No framework-specific dependencies.
// ---------------------------------------------------------------------------

import type { AgentResult } from "../flow-engine/types.js";

// ---- Workflow pipeline definition ------------------------------------------

/** A stage in the workflow pipeline (shown in breadcrumb). */
export interface WorkflowStage {
  name: string; // Display name (e.g., "research", "apply")
  flows: string[]; // Flow/command names that trigger this stage
  detailFn?: (ctx: any) => string; // Dynamic detail (e.g., "wave 2/4")
}

/** Complete workflow definition. */
export interface WorkflowDefinition {
  id: string; // Unique ID (e.g., "sdd")
  stages: WorkflowStage[]; // Ordered pipeline stages
}

// ---- Agent card rendering --------------------------------------------------

/** Card renderer for a specific agent metric type. */
export interface AgentCardRenderer {
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any): void;
  onComplete(result: AgentResult): void;
  renderMetric(width: number): string; // Single metric line (metric-type-specific)
}

/** Agent card status. */
export type CardStatus = "pending" | "running" | "complete" | "error" | "blocked";

/** Card data for tracking agent state in the dashboard. */
export interface CardData {
  agentName: string;
  status: CardStatus;
  stepId?: string;
  startTime?: number;
  endTime?: number;
  renderer: AgentCardRenderer;
  result?: AgentResult;
}
