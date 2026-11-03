/** Spec: decision-routing — decision agent selection chain. */
import { describe, expect, it } from "vitest";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/testing.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

const responder = () => scriptFinish({ status: "complete", summary: "d", branch: "yes" });

function forkFlow(extra: Partial<FlowConfig> = {}, stepAgent?: string): FlowConfig {
  return {
    name: "f", description: "d", source: "<t>", ...extra,
    steps: [
      { stepType: "fork", id: "fk", question: "q?", options: ["yes"], branches: { yes: "next" }, ...(stepAgent ? { agent: stepAgent } : {}) },
      { stepType: "agent", id: "next", agent: "worker", task: "n" },
    ],
  };
}
function adFlow(extra: Partial<FlowConfig> = {}, stepAgent?: string): FlowConfig {
  return {
    name: "f", description: "d", source: "<t>", ...extra,
    steps: [
      { stepType: "agent-decision", id: "dec", task: "decide", branches: { yes: "next" }, ...(stepAgent ? { agent: stepAgent } : {}) } as any,
      { stepType: "agent", id: "next", agent: "worker", task: "n" },
    ],
  };
}
const agents = ["worker", "my-router", "team-router", "verifier", "flow-decision"].map((name) =>
  makeAgent({ name, model: "@fast", modelRefs: ["@fast"] }));

async function who(flow: FlowConfig, opts: { decisionAgent?: string; agentsList?: typeof agents } = {}) {
  const started: string[] = [];
  const r = await runFaux({
    flow, agents: opts.agentsList ?? agents, responder,
    isAutonomous: () => true, decisionAgent: opts.decisionAgent,
    onAgentStarted: (name, stepId) => { if (stepId === "fk" || stepId === "dec") started.push(name); },
  });
  return { started, r };
}

describe("decision agent selection", () => {
  it("flow decision_agent applies to a fork without agent", async () => {
    expect((await who(forkFlow({ decision_agent: "my-router" }))).started[0]).toBe("my-router");
  });
  it("settings decisionAgent applies to agent-decision without agent", async () => {
    expect((await who(adFlow(), { decisionAgent: "team-router" })).started[0]).toBe("team-router");
  });
  it("step agent wins", async () => {
    expect((await who(adFlow({ decision_agent: "my-router" }, "verifier"))).started[0]).toBe("verifier");
  });
  it("flow beats settings", async () => {
    expect((await who(forkFlow({ decision_agent: "my-router" }), { decisionAgent: "team-router" })).started[0]).toBe("my-router");
  });
  it("built-in fallback", async () => {
    expect((await who(forkFlow())).started[0]).toBe("flow-decision");
  });
  it("built-in flow-decision runs without a resolver on the parent model", async () => {
    const { r } = await who(forkFlow());
    expect(r.results.next.status).toBe("complete");
  });
  it("configured agent missing → error naming agent and setting", async () => {
    const { r } = await who(adFlow(), { decisionAgent: "nope" });
    const text = JSON.stringify(r);
    expect(text).toContain("nope");
    expect(text).toContain("flows.decisionAgent");
    expect(r.status).not.toBe("complete");
  });
});

describe("parser", () => {
  it("accepts decision_agent and agent-decision without agent", () => {
    const f = parseFlowYamlString(
      `name: x\ndescription: d\ndecision_agent: my-router\nsteps:\n  - id: a\n    type: agent-decision\n    task: t\n    branches:\n      y: b\n  - id: b\n    type: agent\n    agent: w\n`,
      "t.yaml",
    );
    expect(f.decision_agent).toBe("my-router");
    expect((f.steps[0] as any).agent).toBeUndefined();
  });
});
