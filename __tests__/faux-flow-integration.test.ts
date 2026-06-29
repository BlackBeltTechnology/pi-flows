/**
 * Full-integration faux flow tests — large DAGs exercising every wiring kind:
 *   parallel fan-in, input wiring, code nodes (typed output), code-decision
 *   routing (branch exclusivity), an agent-decision verify/fix LOOP (backward
 *   edge + max_iterations), and skipped-sibling semantics.
 *
 * Written from EXPECTED BEHAVIOUR (docs/flows.md), not implementation. Loop
 * assertions use robust invariants (re-entry happened, loop terminated, exit
 * branch reached) rather than brittle exact iteration counts, because the
 * `${{loop.id.iteration}}` counter timing is an engine-internal detail.
 */

import { describe, it, expect } from "vitest";
import { runFauxFlow, makeAgent, scriptFinish } from "./faux-harness.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

// code node: count + join the two upstream research summaries.
const MERGE_HANDLER = `
export default async function handler(input) {
  const parts = [input.a, input.b].filter(Boolean);
  return { count: String(parts.length), joined: parts.join("|") };
}
`;
// code-decision: route on a computed threshold over the merge count.
const GATE_HANDLER = `
export default async function handler(input) {
  return { branch: Number(input.count) >= 2 ? "pass" : "fail" };
}
`;

/** Shared responder: routes by the dispatched task text. Deterministic. */
function responder(taskText: string) {
  if (/INTAKE/.test(taskText)) return scriptFinish({ status: "complete", summary: "intake done", topic: "WIDGETS" });
  if (/RESEARCH-A/.test(taskText)) return scriptFinish({ status: "complete", summary: `A:${taskText}` });
  if (/RESEARCH-B/.test(taskText)) return scriptFinish({ status: "complete", summary: "B done" });
  if (/BUILD/.test(taskText)) return scriptFinish({ status: "complete", summary: "built" });
  if (/VERIFY/.test(taskText)) {
    const m = taskText.match(/attempt (\d+)\//);
    const iter = m ? Number(m[1]) : 1;
    // rework (loop back) until the iteration counter advances past 1, then exit.
    return scriptFinish({ status: "complete", summary: `verify ${iter}`, branch: iter < 2 ? "rework" : "done" });
  }
  if (/REMEDIATE/.test(taskText)) return scriptFinish({ status: "complete", summary: "remediated" });
  if (/FINALIZE/.test(taskText)) return scriptFinish({ status: "complete", summary: "finalized" });
  return scriptFinish({ status: "complete", summary: "default" });
}

const AGENTS = [
  makeAgent({ name: "intake", model: "faux/faux-1", outputs: [{ name: "topic" }] }),
  makeAgent({ name: "worker", model: "faux/faux-1" }),
  makeAgent({ name: "verifier", model: "faux/faux-1" }),
];

// ── Big flow: fan-in → code → code-decision(pass) → build → verify-LOOP → finalize ──

function kitchenSinkFlow(): FlowConfig {
  return {
    name: "kitchen-sink",
    description: "every wiring kind on the pass path",
    source: "<faux>",
    max_concurrent: 3,
    steps: [
      { stepType: "agent", id: "intake", agent: "intake", task: "INTAKE: determine topic" },
      { stepType: "agent", id: "research-a", agent: "worker", blockedBy: ["intake"], task: "RESEARCH-A on ${{result.intake.topic}}" },
      { stepType: "agent", id: "research-b", agent: "worker", blockedBy: ["intake"], task: "RESEARCH-B" },
      {
        stepType: "code", id: "merge", blockedBy: ["research-a", "research-b"],
        inputs: { a: "${{result.research-a.summary}}", b: "${{result.research-b.summary}}" },
        outputs: [{ name: "count" }, { name: "joined" }],
      },
      {
        stepType: "code-decision", id: "gate", blockedBy: ["merge"],
        inputs: { count: "${{result.merge.count}}" },
        branches: { pass: "build", fail: "remediate" },
      },
      { stepType: "agent", id: "remediate", agent: "worker", task: "REMEDIATE the gate failure" },
      { stepType: "agent", id: "build", agent: "worker", task: "BUILD attempt" },
      {
        stepType: "agent-decision", id: "verify", agent: "verifier",
        task: "VERIFY attempt ${{loop.verify.iteration}}/${{loop.verify.max}}",
        branches: { rework: "build", done: "finalize" },
        max_iterations: 3,
      },
      { stepType: "agent", id: "finalize", agent: "worker", task: "FINALIZE the build" },
    ],
  };
}

describe("faux runFlow — kitchen-sink integration (pass path with verify loop)", () => {
  it("wires fan-in + code outputs + code-decision pass routing + an agent-decision loop", async () => {
    const completed: string[] = [];
    const result = await runFauxFlow({
      flow: kitchenSinkFlow(),
      agents: AGENTS,
      responder,
      codeHandlers: { merge: MERGE_HANDLER, gate: GATE_HANDLER },
      onAgentComplete: (_a, stepId) => completed.push(stepId),
    });

    // Fan-in input wiring: research-a received intake.topic.
    expect(result.results.intake.outputs.topic).toBe("WIDGETS");
    expect(result.results["research-a"].summary).toContain("WIDGETS");
    expect(result.results["research-b"].status).toBe("complete");

    // Code node typed outputs flow downstream.
    expect(result.results.merge.outputs.count).toBe("2");
    expect(result.results.merge.outputs.joined as string).toContain("WIDGETS");

    // code-decision routed PASS → build ran, remediate skipped (branch exclusivity).
    expect(result.results.build.status).toBe("complete");
    expect(result.results.remediate.status).toBe("skipped");

    // agent-decision LOOP re-entered build (>1) and terminated within the cap.
    const buildRuns = completed.filter((s) => s === "build").length;
    expect(buildRuns).toBeGreaterThanOrEqual(2);
    expect(buildRuns).toBeLessThanOrEqual(3 + 1); // bounded by max_iterations
    expect(result.results.verify.summary).toContain("verify 2"); // exited on "done"

    // Forward exit branch reached.
    expect(result.results.finalize.summary).toBe("finalized");
  });
});

// ── Clean fail-branch flow: code-decision with two terminal branches ──

function gateFlow(): FlowConfig {
  return {
    name: "gate-only",
    description: "code-decision branch exclusivity",
    source: "<faux>",
    max_concurrent: 2,
    steps: [
      { stepType: "agent", id: "intake", agent: "intake", task: "INTAKE" },
      { stepType: "agent", id: "ra", agent: "worker", blockedBy: ["intake"], task: "RESEARCH-A ${{result.intake.topic}}" },
      { stepType: "agent", id: "rb", agent: "worker", blockedBy: ["intake"], task: "RESEARCH-B" },
      {
        stepType: "code", id: "merge", blockedBy: ["ra", "rb"],
        inputs: { a: "${{result.ra.summary}}", b: "${{result.rb.summary}}" },
        outputs: [{ name: "count" }],
      },
      {
        stepType: "code-decision", id: "gate", blockedBy: ["merge"],
        inputs: { count: "${{result.merge.count}}" },
        branches: { pass: "build", fail: "remediate" },
      },
      { stepType: "agent", id: "build", agent: "worker", task: "BUILD" },
      { stepType: "agent", id: "remediate", agent: "worker", task: "REMEDIATE" },
    ],
  };
}

describe("faux runFlow — code-decision FAIL branch exclusivity", () => {
  it("a sub-threshold count routes to remediate and skips the pass branch", async () => {
    // merge reports count "1" → gate handler returns branch "fail".
    const failMerge = `export default async function handler() { return { count: "1" }; }`;

    const result = await runFauxFlow({
      flow: gateFlow(),
      agents: AGENTS,
      responder,
      codeHandlers: { merge: failMerge, gate: GATE_HANDLER },
    });

    expect(result.results.merge.outputs.count).toBe("1");
    expect(result.results.remediate.summary).toBe("remediated");
    expect(result.results.build.status).toBe("skipped");
  });
});
