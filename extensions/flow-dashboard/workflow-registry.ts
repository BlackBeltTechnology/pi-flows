import type { WorkflowDefinition } from "./types.js";

// Use a global symbol to share the workflow registry across jiti module instances.
// Without this, dynamic imports from different extensions get separate module copies.
const REGISTRY_KEY = Symbol.for("pi-flow-dashboard-workflows");

function getWorkflows(): WorkflowDefinition[] {
  const g = globalThis as any;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = [];
  return g[REGISTRY_KEY];
}

export function registerWorkflow(def: WorkflowDefinition): void {
  getWorkflows().push(def);
}

export function resolveWorkflow(flowName: string): { workflow: WorkflowDefinition; stageIndex: number } | null {
  // Prefer the most specific workflow (fewest stages) to avoid
  // matching broad pipelines when a standalone workflow exists.
  let best: { workflow: WorkflowDefinition; stageIndex: number } | null = null;
  for (const wf of getWorkflows()) {
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
  return getWorkflows()[0];
}
