/**
 * A decision agent that finishes with status "blocked" or "error" has not
 * decided, even if it also passes a `branch` (found in a live GLM run: the judge
 * reported "blocked" and the flow still looped on its branch).
 */
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";

const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n\n\${{task}}\n`;

const FLOW = (onError: boolean) => `name: blk
description: blocked decision
decision_agent: judge
steps:
  - id: gate
    type: agent-decision
    task: "GATE decide"
    branches:
      go: work
      stop: end
${onError ? "    on_error: rescue\n" : ""}  - id: work
    type: agent
    agent: worker
    task: "WORK"
  - id: rescue
    type: agent
    agent: worker
    task: "RESCUE"
  - id: end
    type: agent
    agent: worker
    task: "END"
`;

const run = (status: "blocked" | "error" | "complete", onError: boolean, events: DecisionEvent[] = []) =>
  runFaux({
    flow: parseFlowYamlString(FLOW(onError), "<t>"),
    agents: ["worker", "judge"].map((n) => parseAgentString(agentMd(n), "<t>")),
    isAutonomous: () => true,
    onDecision: (e) => events.push(e),
    responder: (t) => /GATE/.test(t)
      ? scriptFinish({ status, summary: "cannot tell", branch: "go" })
      : scriptFinish({ status: "complete", summary: "ok" }),
  });

describe("decision agent finishing blocked/error does not route", () => {
  for (const status of ["blocked", "error"] as const) {
    it(`status "${status}" with a branch is a failed attempt; on_error routes`, async () => {
      const events: DecisionEvent[] = [];
      const result = await run(status, true, events);
      expect(result.results.work?.status ?? "skipped").not.toBe("complete");
      expect(result.results.rescue?.status).toBe("complete");
      expect(events).toHaveLength(1);
      expect(events[0].routedBy).toBeUndefined();
      expect(events[0].attempts[0].outcome).not.toBe("ok");
      expect(events[0].attempts[0].reason ?? "").toMatch(new RegExp(status));
    });
  }

  it("status blocked without on_error fails the flow", async () => {
    const result = await run("blocked", false);
    expect(result.status).not.toBe("success");
    expect(result.results.work?.status ?? "skipped").not.toBe("complete");
  });

  it("status complete with a branch still routes", async () => {
    const result = await run("complete", true);
    expect(result.results.work?.status).toBe("complete");
    expect(result.results.rescue?.status ?? "skipped").not.toBe("complete");
  });
});
