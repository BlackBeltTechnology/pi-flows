// Bounded retries on a BAD finish (not only a missing one).
// spec: node-failure-model "Capped no-finish reminder" — the 2-reminder cap
// must also apply when the agent keeps calling `finish` with args that fail
// the finish schema (invalid/missing decision branch, missing declared output).
import { describe, expect, it } from "vitest";
import { runFaux, spawnFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

const CAP = 2; // MAX_FINISH_RETRIES
const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n`;

const FLOW = (onError: boolean) => `name: badfinish
description: decision with a recovery step
decision_agent: judge
steps:
  - id: route
    type: agent-decision
    task: "DECIDE the route"
    branches:
      a: left
      b: right
${onError ? "    on_error: fallback\n" : ""}  - id: left
    type: agent
    agent: worker
    task: "LEFT"
  - id: right
    type: agent
    agent: worker
    task: "RIGHT"
  - id: fallback
    type: agent
    agent: worker
    task: "FALLBACK"
`;

const agents = () => [agentMd("worker"), agentMd("judge")].map((m) => parseAgentString(m, "<t>"));

describe("bad-finish retry cap — decision agent", () => {
  it("always finishing with an invalid branch fails SOFT after a bounded number of attempts; on_error routes", async () => {
    let decisionTurns = 0;
    const result = await runFaux({
      flow: parseFlowYamlString(FLOW(true), "<t>"),
      agents: agents(),
      maxTurns: 40,
      responder: (t) => {
        if (/DECIDE|You did not call|did not (?:pass|satisf)/i.test(t)) {
          decisionTurns++;
          return scriptFinish({ status: "complete", summary: "x", branch: "maybe" });
        }
        const marker = /\b(LEFT|RIGHT|FALLBACK)\b/.exec(t)?.[1] ?? "?";
        return scriptFinish({ status: "complete", summary: `${marker} done` });
      },
    });
    expect(decisionTurns).toBeLessThanOrEqual(CAP + 1); // initial attempt + cap reminders
    expect(result.status).toBe("success"); // soft failure routed, flow not hard-failed
    expect(result.results.route.status).toBe("error");
    expect(result.results.fallback.summary).toBe("FALLBACK done");
    expect(result.results.left.status).toBe("skipped");
    expect(result.results.right.status).toBe("skipped");
  });

  it("the failure message names the invalid branch and the valid ones", async () => {
    const result = await runFaux({
      flow: parseFlowYamlString(FLOW(true), "<t>"),
      agents: agents(),
      maxTurns: 40,
      responder: (t) => {
        if (/DECIDE|You did not call/i.test(t)) return scriptFinish({ status: "complete", summary: "x", branch: "maybe" });
        return scriptFinish({ status: "complete", summary: "other done" });
      },
    });
    expect(result.results.route.status).toBe("error");
    expect(result.results.route.summary).toMatch(/invalid branch "maybe"/);
    expect(result.results.route.summary).toMatch(/valid: a, b/);
  });

  it("one bad finish then a correct one routes on the correct label (no regression)", async () => {
    let n = 0;
    const result = await runFaux({
      flow: parseFlowYamlString(FLOW(false), "<t>"),
      agents: agents(),
      responder: (t) => {
        if (/DECIDE/.test(t)) return scriptFinish({ status: "complete", summary: "x", branch: ++n === 1 ? "maybe" : "b" });
        const marker = /\b(LEFT|RIGHT)\b/.exec(t)?.[1] ?? "?";
        return scriptFinish({ status: "complete", summary: `${marker} done` });
      },
    });
    expect(result.status).toBe("success");
    expect(result.results.right.summary).toBe("RIGHT done");
    expect(result.results.left.status).toBe("skipped");
  });
});

describe("bad-finish retry cap — declared outputs", () => {
  it("a plain agent that keeps omitting a required declared output fails SOFT after a bounded number of attempts", async () => {
    const total = 30;
    const { result, faux } = await spawnFaux({
      agent: { outputs: [{ name: "verdict" }] } as any,
      responses: Array.from({ length: total }, () => scriptFinish({ status: "complete", summary: "done" })),
    });
    expect(total - faux.getPendingResponseCount()).toBeLessThanOrEqual(CAP + 1);
    expect(result.outcome).toBe("soft");
    expect(result.success).toBe(false);
    expect(result.failureInfo?.message).toMatch(/verdict/);
  });
});
