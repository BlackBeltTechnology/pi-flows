/**
 * A decision agent receives the same inputs a classifier does: the expanded
 * `state:` map and each branch's `means` (found in a live GLM run, where the
 * judge only saw `task:` and the bare branch names and decided blind).
 */
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n\n\${{task}}\n`;

const FLOW = `name: seen
description: decision agent context
decision_agent: judge
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK"
  - id: gate
    type: agent-decision
    task: "GATE is it acceptable?"
    state:
      review: "\${{result.work.summary}}"
    branches:
      done: { to: end, means: "The review found no problems" }
      fix: { to: end, means: "The review found a problem" }
  - id: end
    type: agent
    agent: worker
    task: "END"
`;

describe("decision agent sees state and branch means", () => {
  it("the decision agent's prompt carries the expanded state and every branch's means", async () => {
    const flow = parseFlowYamlString(FLOW, "<t>");
    const agents = ["worker", "judge"].map((n) => parseAgentString(agentMd(n), "<t>"));
    let gatePrompt = "";
    const result = await runFaux({
      flow, agents, isAutonomous: () => true,
      responder: (t) => {
        if (/GATE/.test(t)) { gatePrompt = t; return scriptFinish({ status: "complete", summary: "ok", branch: "done" }); }
        if (/WORK/.test(t)) return scriptFinish({ status: "complete", summary: "REVIEW-TEXT-42 no issues" });
        return scriptFinish({ status: "complete", summary: "end" });
      },
    });
    expect(result.status).toBe("success");
    expect(gatePrompt).toContain("GATE is it acceptable?");
    expect(gatePrompt).toContain("review");
    expect(gatePrompt).toContain("REVIEW-TEXT-42 no issues");
    expect(gatePrompt).toContain("done");
    expect(gatePrompt).toContain("The review found no problems");
    expect(gatePrompt).toContain("fix");
    expect(gatePrompt).toContain("The review found a problem");
  });

  it("without state: or means the prompt is the task plus the branch names", async () => {
    const yaml = FLOW.replace(/ {4}state:\n {6}review: .*\n/, "")
      .replace('{ to: end, means: "The review found no problems" }', "end")
      .replace('{ to: end, means: "The review found a problem" }', "end");
    const flow = parseFlowYamlString(yaml, "<t>");
    const agents = ["worker", "judge"].map((n) => parseAgentString(agentMd(n), "<t>"));
    let gatePrompt = "";
    await runFaux({
      flow, agents, isAutonomous: () => true,
      responder: (t) => {
        if (/GATE/.test(t)) { gatePrompt = t; return scriptFinish({ status: "complete", summary: "ok", branch: "done" }); }
        return scriptFinish({ status: "complete", summary: "x" });
      },
    });
    expect(gatePrompt).toContain("GATE is it acceptable?");
    expect(gatePrompt).toMatch(/done/);
    expect(gatePrompt).toMatch(/fix/);
    expect(gatePrompt).not.toContain("REVIEW-TEXT");
  });
});
