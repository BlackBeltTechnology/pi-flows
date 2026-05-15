import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflow, resolveWorkflow } from "./workflow-registry.js";
import { getCardRenderer, initCardTypes, registerMetric } from "./card-registry.js";

export { registerWorkflow, resolveWorkflow } from "./workflow-registry.js";
export { getCardRenderer, initCardTypes, registerMetric } from "./card-registry.js";
export type { WorkflowDefinition, WorkflowStage, AgentCardRenderer, CardStatus, CardData } from "./types.js";
export { AgentDashboard } from "./agent-dashboard.js";
export type { DetailEntry } from "./agent-dashboard.js";
export { renderBreadcrumb } from "./breadcrumb.js";
export { renderDetailView, createDetailScrollState, moveUp, moveDown, toggleExpand, computeExpandedContentLines } from "./detail-view.js";
export type { DetailScrollState, DetailViewData } from "./detail-view.js";
export type { DashboardMode } from "./agent-dashboard.js";
export { createAgentDetailOverlay } from "./agent-detail-overlay.js";
export type { AgentDetailOverlayOptions } from "./agent-detail-overlay.js";
export { createFlowPreviewOverlay } from "./flow-preview-overlay.js";
export type { FlowPreviewOverlayOptions } from "./flow-preview-overlay.js";
export { renderBox } from "./box-renderer.js";
export type { BoxOptions } from "./box-renderer.js";

export function activate(pi: ExtensionAPI) {
  // Initialize built-in metric renderers (default, files, tests)
  initCardTypes();

  // Expose event-based registration for external extensions
  // flow:register-card — register a custom metric renderer
  pi.events.on("flow:register-card", (data: unknown) => {
    const { name, factory } = data as { name: string; factory: () => any };
    if (name && factory) {
      registerMetric(name, factory);
    }
  });

  // flow:register-workflow — register a workflow definition
  pi.events.on("flow:register-workflow", (data: unknown) => {
    const def = data as any;
    if (def?.id && def?.stages) {
      registerWorkflow(def);
    }
  });
}
