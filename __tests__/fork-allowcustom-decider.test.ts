/**
 * allowCustom on a fork: the validator and the runtime agree on what can route
 * an "Other" answer — step agent:, a decider chain, the flow's decision_agent:,
 * or (runtime only, invisible to the validator) the flows.decider setting.
 */
import { describe, expect, it } from "vitest";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

const flow = (head = "", forkAgent = "") => `name: fc
description: d
${head}steps:
  - id: fk
    type: fork
${forkAgent}    question: "Pick"
    options: [a, b]
    allowCustom: true
    branches:
      a: sa
      b: sb
  - id: sa
    type: agent
    agent: w
    task: "A"
  - id: sb
    type: agent
    agent: w
    task: "B"
`;
const diags = (y: string) => validateFlowContent(y, () => new Map()).diagnostics.filter((d) => /allowCustom/.test(d.message));

describe("fork allowCustom: validator", () => {
  it("no agent, no decider, no decision_agent → warning (not error) naming the flows.decider setting", () => {
    const d = diags(flow());
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
    expect(d[0].message + (d[0].suggestion ?? "")).toMatch(/flows\.decider/);
  });
  it("flow decision_agent: counts as a decider (no diagnostic)", () => {
    expect(diags(flow("decision_agent: judge\n"))).toEqual([]);
  });
  it("step agent: counts (no diagnostic)", () => {
    expect(diags(flow("", "    agent: judge\n"))).toEqual([]);
  });
});

describe("fork allowCustom: runtime", () => {
  const md = (n: string) => `---\nname: ${n}\ndescription: d\nmodel: faux/faux-1\ntools: read\n---\n\nx \${{task}}\n`;
  it("flow decision_agent: routes an Other answer and offers auto-decide", async () => {
    const extras: any[] = [];
    const r = await runFaux({
      flow: parseFlowYamlString(flow("decision_agent: judge\n"), "<t>"),
      agents: ["w", "judge"].map((n) => parseAgentString(md(n), "<t>")),
      isAutonomous: () => false,
      askUser: async (_q: string, _t: string, _o: string[], extra: any) => { extras.push(extra); return { answer: "__custom_decide__", notes: "the second one" }; },
      responder: (t: string) => /second one/.test(t) ? scriptFinish({ status: "complete", summary: "b", branch: "b" }) : scriptFinish({ status: "complete", summary: "ok" }),
    } as any);
    expect(extras[0].hasAutoAgent).toBe(true);
    expect(r.results.sb?.status).toBe("complete");
  });
});
