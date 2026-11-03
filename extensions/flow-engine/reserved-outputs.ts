// ---------------------------------------------------------------------------
// Reserved agent output names: the finish tool's own fields. An agent output
// with one of these names overwrites the engine's field (e.g. `status: "done"`
// turns a success into a failure), so they are rejected everywhere: at
// authoring (validators), at discovery (warning) and at flow start (error).
// ---------------------------------------------------------------------------
import type { AgentConfig, FlowConfig } from "./types.js";

/** Output names that collide with the `finish` tool's own fields. */
export const RESERVED_FINISH_OUTPUTS = ["status", "summary", "files", "artifacts"];

/** Reserved names an agent declares; `branch` counts only for decision agents. */
export function reservedOutputsOf(agent: Pick<AgentConfig, "outputs">, decision = false): string[] {
  const names = (agent.outputs ?? []).map((o) => o.name);
  return names.filter((n) => RESERVED_FINISH_OUTPUTS.includes(n) || (decision && n === "branch"));
}

/** One line per offending agent used by the flow, or [] when the flow is clean. */
export function reservedOutputProblems(flow: FlowConfig, getAgent: (name: string) => AgentConfig | undefined): string[] {
  const usage = new Map<string, boolean>(); // agent name → used as a decision agent
  const use = (name: string | undefined, decision: boolean) => {
    if (name) usage.set(name, (usage.get(name) ?? false) || decision);
  };
  use(flow.decision_agent, true);
  for (const step of flow.steps) {
    const agent = (step as { agent?: string }).agent;
    use(agent, step.stepType === "agent-decision" || step.stepType === "fork");
  }
  const problems: string[] = [];
  for (const [name, decision] of usage) {
    const cfg = getAgent(name);
    const bad = cfg ? reservedOutputsOf(cfg, decision) : [];
    if (bad.length) {
      problems.push(`agent "${name}" declares reserved output ${bad.map((b) => `"${b}"`).join(", ")}; rename it (e.g. "outcome")`);
    }
  }
  return problems;
}
