import type { WorkflowDefinition } from "./types.js";

export function renderBreadcrumb(
  workflow: WorkflowDefinition,
  currentIndex: number,
  stageDetail: string,
  width: number,
  theme?: any
): string {
  const parts = workflow.stages.map((stage, i) => {
    if (i < currentIndex) return theme?.fg?.("success", `✓ ${stage.name}`) ?? `✓ ${stage.name}`;
    if (i === currentIndex) {
      const detail = stageDetail ? ` ${stageDetail}` : "";
      return theme?.fg?.("accent", `[${stage.name}${detail}]`) ?? `[${stage.name}${detail}]`;
    }
    return theme?.fg?.("dim", stage.name) ?? stage.name;
  });
  const raw = parts.join(" → ");
  return raw.length > width ? raw.slice(0, width) : raw;
}
