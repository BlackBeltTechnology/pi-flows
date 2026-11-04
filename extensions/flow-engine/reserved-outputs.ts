// ---------------------------------------------------------------------------
// Reserved agent output names: the finish tool's own fields. An agent output
// with one of these names overwrites the engine's field (e.g. `status: "done"`
// turns a success into a failure), so they are rejected everywhere: at
// authoring (validators), at discovery (warning) and at flow start (error).
// ---------------------------------------------------------------------------
import type { AgentConfig, FlowConfig } from "./types.js";

/** Output names that collide with the `finish` tool's own fields. */
export const RESERVED_FINISH_OUTPUTS = ["status", "summary", "files", "artifacts"];

/**
 * Reserved names an agent declares; `branch` counts only for decision agents,
 * `branches` only for agents deciding a `multi: true` decision.
 */
export function reservedOutputsOf(agent: Pick<AgentConfig, "outputs">, decision = false, multi = false): string[] {
  const names = (agent.outputs ?? []).map((o) => o.name);
  return names.filter((n) => RESERVED_FINISH_OUTPUTS.includes(n) || (decision && n === "branch") || (multi && n === "branches"));
}

/** One line per offending agent used by the flow, or [] when the flow is clean. */
export function reservedOutputProblems(flow: FlowConfig, getAgent: (name: string) => AgentConfig | undefined): string[] {
  // agent name → 0 plain, 1 decision agent, 2 multi decision agent
  const usage = new Map<string, number>();
  const use = (name: string | undefined, level: number) => {
    if (name) usage.set(name, Math.max(usage.get(name) ?? 0, level));
  };
  use(flow.decision_agent, 1);
  for (const step of flow.steps) {
    const agent = (step as { agent?: string }).agent;
    const multi = step.stepType === "agent-decision" && step.multi === true;
    use(multi ? agent ?? flow.decision_agent : agent, multi ? 2 : step.stepType === "agent-decision" || step.stepType === "fork" ? 1 : 0);
  }
  const problems: string[] = [];
  for (const [name, level] of usage) {
    const cfg = getAgent(name);
    const bad = cfg ? reservedOutputsOf(cfg, level >= 1, level === 2) : [];
    if (bad.length) {
      problems.push(`agent "${name}" declares reserved output ${bad.map((b) => `"${b}"`).join(", ")}; rename it (e.g. "outcome")`);
    }
  }
  return problems;
}
