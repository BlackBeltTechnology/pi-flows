import type { WorkflowDefinition } from "./types.js";

// Module-level registry shared across all extensions via the single entry point.
const workflows: WorkflowDefinition[] = [];

export function registerWorkflow(def: WorkflowDefinition): void {
  workflows.push(def);
}

export function resolveWorkflow(flowName: string): { workflow: WorkflowDefinition; stageIndex: number } | null {
  // Prefer the most specific workflow (fewest stages) to avoid
  // matching broad pipelines when a standalone workflow exists.
  let best: { workflow: WorkflowDefinition; stageIndex: number } | null = null;
  for (const wf of workflows) {
    const idx = wf.stages.findIndex(s => s.flows.includes(flowName));
    if (idx >= 0) {
      if (!best || wf.stages.length < best.workflow.stages.length) {
        best = { workflow: wf, stageIndex: idx };
      }
    }
  }
  return best;
}

export function getActiveWorkflow(): WorkflowDefinition | undefined {
  return workflows[0];
}
