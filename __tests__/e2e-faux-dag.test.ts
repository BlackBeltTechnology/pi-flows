/**
 * End-to-end faux DAG scenarios: realistic pipelines authored as YAML and run
 * on the real runFlow via runFauxFlow (scripted faux provider, zero network).
 *
 * Written from the documented behaviour (docs/flows.md: parallel DAG segments,
 * max_concurrent, routing nodes, loops, failure model, typed flow inputs;
 * openspec/specs/decision-routing). Responders route on task text, never on
 * call order, so parallel steps stay deterministic.
 *
 * Not covered: `flow-ref` (sub-flow) — there is no such step type in this
 * version of pi-flows (parser, types, docs), so there is nothing to test.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { makeAgent, runFauxFlow, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";

const AGENTS = [
  makeAgent({ name: "planner", model: "faux/faux-1" }),
  makeAgent({ name: "worker", model: "faux/faux-1" }),
  makeAgent({ name: "merger", model: "faux/faux-1" }),
];

const ok = (summary: string, extra: Record<string, unknown> = {}) =>
  scriptFinish({ status: "complete", summary, ...extra });

/** Reply prose plus a finish call in one turn: the prose is the step's fullOutput. */
const reply = (text: string, summary: string, extra: Record<string, unknown> = {}) =>
  fauxAssistantMessage([fauxText(text), fauxToolCall("finish", { status: "complete", summary, files: [], ...extra })]);

/** Track step lifecycle through onAgentStarted / onAgentComplete. */
function tracker() {
  const log: string[] = []; // "start:<id>" | "done:<id>" in observed order
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    log,
    get maxInFlight() { return maxInFlight; },
    started: (id: string) => log.includes(`start:${id}`),
    count: (id: string) => log.filter((l) => l === `start:${id}`).length,
    onAgentStarted: (_a: string, stepId: string) => {
      log.push(`start:${stepId}`);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
    },
    onAgentComplete: (_a: string, stepId: string) => {
      log.push(`done:${stepId}`);
      inFlight--;
    },
  };
}

describe("e2e faux DAG: fan-out / fan-in", () => {
  const FLOW = `name: fan
description: planner -> 3 workers -> merger
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN \${{task}}"
  - id: w1
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "WORK-1 of \${{result.plan.summary}}"
  - id: w2
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "WORK-2 of \${{result.plan.summary}}"
  - id: w3
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "WORK-3 of \${{result.plan.summary}}"
  - id: merge
    type: agent
    agent: merger
    blockedBy: [w1, w2, w3]
    task: "MERGE \${{result.w1.summary}} + \${{result.w2.summary}} + \${{result.w3.summary}}"
`;

  it("workers run concurrently after the planner; the merger sees all three summaries", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(FLOW, "<fan>"),
      agents: AGENTS,
      responder: (task) => {
        // The dispatched message is "Task: <task>"; check WORK/MERGE before PLAN
        // because worker/merger tasks embed the planner's summary ("PLANNED").
        const w = task.match(/WORK-(\d) of (\w+)/);
        if (w) return ok(`result-${w[1]}(${w[2]})`);
        if (/MERGE/.test(task)) return ok(`merged: ${task}`);
        if (/PLAN/.test(task)) return ok("PLANNED");
        return ok("default");
      },
      onAgentStarted: t.onAgentStarted,
      onAgentComplete: t.onAgentComplete,
    });

    expect(result.status).toBe("success");
    // Planner output flows into every worker task.
    for (const n of [1, 2, 3]) expect(result.results[`w${n}`].summary).toBe(`result-${n}(PLANNED)`);

    // Concurrency: all three workers started before ANY worker completed.
    const firstWorkerDone = Math.min(...["w1", "w2", "w3"].map((w) => t.log.indexOf(`done:${w}`)));
    for (const w of ["w1", "w2", "w3"]) expect(t.log.indexOf(`start:${w}`)).toBeLessThan(firstWorkerDone);
    expect(t.maxInFlight).toBe(3);

    // Ordering: planner finished before workers; merger started after all workers finished.
    for (const w of ["w1", "w2", "w3"]) {
      expect(t.log.indexOf("done:plan")).toBeLessThan(t.log.indexOf(`start:${w}`));
      expect(t.log.indexOf(`done:${w}`)).toBeLessThan(t.log.indexOf("start:merge"));
    }

    // Fan-in: the merger task contained all three summaries.
    const merged = result.results.merge.summary;
    expect(merged).toContain("result-1(PLANNED)");
    expect(merged).toContain("result-2(PLANNED)");
    expect(merged).toContain("result-3(PLANNED)");
  });

  it("fan-in of reply text: ${{result.wN.fullOutput}} / bare ${{result.wN}} carry each worker's prose, not its summary", async () => {
    const yaml = FLOW.replace(
      'task: "MERGE ${{result.w1.summary}} + ${{result.w2.summary}} + ${{result.w3.summary}}"',
      'task: "MERGE <${{result.w1.fullOutput}}> <${{result.w2}}> <${{result.w3.fullOutput}}> sums=${{result.w1.summary}}"',
    );
    let mergeTask = "";
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<fan-full>"),
      agents: AGENTS,
      responder: (task) => {
        const w = task.match(/WORK-(\d)/);
        if (w) return reply(`section ${w[1]} body\nwith two lines`, `wrote section ${w[1]}`);
        if (/MERGE/.test(task)) { mergeTask = task; return ok("merged"); }
        return ok("PLANNED");
      },
    });
    expect(result.status).toBe("success");
    for (const n of [1, 2, 3]) {
      expect(result.results[`w${n}`].summary).toBe(`wrote section ${n}`);
      expect(mergeTask).toContain(`<section ${n} body\nwith two lines>`);
    }
    expect(mergeTask).toContain("sums=wrote section 1");
  });

  it("flow-level max_concurrent: 2 never runs more than 2 of 4 workers at once", async () => {
    const yaml = `name: limited
description: bounded parallelism
max_concurrent: 2
steps:
${[1, 2, 3, 4].map((n) => `  - id: w${n}
    type: agent
    agent: worker
    task: "WORK-${n}"
`).join("")}  - id: merge
    type: agent
    agent: merger
    blockedBy: [w1, w2, w3, w4]
    task: "MERGE"
`;
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<limited>"),
      agents: AGENTS,
      responder: (task) => ok(`done ${task}`),
      onAgentStarted: t.onAgentStarted,
      onAgentComplete: t.onAgentComplete,
    });

    expect(result.status).toBe("success");
    for (const n of [1, 2, 3, 4]) expect(result.results[`w${n}`].status).toBe("complete");
    expect(result.results.merge.status).toBe("complete");
    expect(t.maxInFlight).toBeLessThanOrEqual(2);
    expect(t.maxInFlight).toBe(2); // and the cap is actually used (parallelism did happen)
  });
});

describe("e2e faux DAG: code → code-decision → branches", () => {
  const FLOW = `name: route
description: measure, route by score, report
steps:
  - id: measure
    type: code
    outputs:
      - name: score
  - id: route
    type: code-decision
    blockedBy: [measure]
    inputs:
      score: "\${{result.measure.score}}"
    branches:
      high: celebrate
      low: remediate
  - id: celebrate
    type: agent
    agent: worker
    task: "CELEBRATE score \${{result.measure.score}}"
  - id: remediate
    type: agent
    agent: worker
    task: "REMEDIATE score \${{result.measure.score}}"
`;
  const handlers = (score: number) => ({
    measure: `export default async () => ({ score: ${score} });`,
    route: `export default async (input) => ({ branch: input.score >= 5 ? "high" : "low" });`,
  });
  const responder = (task: string) => {
    if (/CELEBRATE/.test(task)) return ok("celebrated");
    if (/REMEDIATE/.test(task)) return ok("remediated");
    return ok("default");
  };

  it("high score: takes `high`, skips `low`; skipped step summary expands empty", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(FLOW, "<route>"),
      agents: AGENTS, responder, codeHandlers: handlers(9),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("success");
    expect(result.results.route.status).toBe("complete"); // routing nodes always execute
    expect(result.results.celebrate.summary).toBe("celebrated");
    expect(result.results.remediate.status).toBe("skipped");
    expect(t.started("remediate")).toBe(false);
  });

  it("low score: takes `low`, skips `high`", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(FLOW, "<route>"),
      agents: AGENTS, responder, codeHandlers: handlers(1),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.results.remediate.summary).toBe("remediated");
    expect(result.results.celebrate.status).toBe("skipped");
    expect(t.started("celebrate")).toBe(false);
  });

  it("a reference to the untaken branch's summary expands to the empty string", async () => {
    // A join step after both branches reads both summaries; only one exists.
    const yaml = FLOW + `  - id: report
    type: agent
    agent: merger
    blockedBy: [celebrate, remediate]
    task: "REPORT high=[\${{result.celebrate.summary}}] low=[\${{result.remediate.summary}}]"
`;
    let reportTask = "";
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<route>"),
      agents: AGENTS,
      responder: (task) => {
        if (/REPORT/.test(task)) { reportTask = task; return ok("reported"); }
        return responder(task);
      },
      codeHandlers: handlers(9),
    });
    expect(result.results.report?.status).toBe("complete");
    expect(reportTask).toContain("high=[celebrated]");
    expect(reportTask).toContain("low=[]");
    expect(reportTask).not.toContain("undefined");
  });
});

describe("e2e faux DAG: code → agent-decision", () => {
  const FLOW = `name: judge-score
description: measure, let a decision agent judge the score
decision_agent: merger
steps:
  - id: measure
    type: code
    outputs:
      - name: score
      - name: notes
  - id: judge
    type: agent-decision
    blockedBy: [measure]
    task: "JUDGE the build for \${{task}}"
    state:
      score: "\${{result.measure.score}}"
      notes: "\${{result.measure.notes}}"
    branches:
      ship: { to: celebrate, means: "Score is high enough to release" }
      rework: remediate
  - id: celebrate
    type: agent
    agent: worker
    task: "CELEBRATE"
  - id: remediate
    type: agent
    agent: worker
    task: "REMEDIATE"
`;

  it("the decision agent's task carries branch means and the code outputs as expanded state", async () => {
    let judgeTask = "";
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(FLOW, "<judge-score>"),
      agents: AGENTS,
      task: "release 7",
      codeHandlers: { measure: `export default async () => ({ score: 9, notes: { flaky: ["t1"] } });` },
      responder: (task) => {
        if (/JUDGE/.test(task)) { judgeTask = task; return ok("judged", { branch: "ship" }); }
        return ok(/CELEBRATE/.test(task) ? "celebrated" : "remediated");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("success");
    expect(result.results.celebrate.summary).toBe("celebrated");
    expect(result.results.remediate.status).toBe("skipped");
    expect(t.started("remediate")).toBe(false);
    expect(judgeTask).toContain(
      "JUDGE the build for release 7\n\nBranches (call finish with exactly one of these as `branch`):\n" +
      "- ship: Score is high enough to release\n- rework\n\n" +
      'State:\n- score: 9\n- notes: {"flaky":["t1"]}',
    );
  });

  it("a decision agent that finishes blocked (naming a branch) halts the flow: neither branch runs", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(FLOW, "<judge-score>"),
      agents: AGENTS,
      codeHandlers: { measure: `export default async () => ({ score: 9, notes: "" });` },
      responder: (task) => /JUDGE/.test(task)
        ? scriptFinish({ status: "blocked", summary: "no baseline", branch: "ship" })
        : ok("ran"),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("error");
    expect(t.started("celebrate")).toBe(false);
    expect(t.started("remediate")).toBe(false);
    expect(result.lastResult.result.summary).toContain("the decision agent finished with status blocked");
  });
});

describe("e2e faux DAG: code-decision loop with max_iterations", () => {
  it("a handler that never says `done` is forced out by the cap (re-entries == max_iterations)", async () => {
    const yaml = `name: capped
description: loop that never converges
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK pass \${{loop.check.iteration}}"
  - id: check
    type: code-decision
    blockedBy: [work]
    branches:
      again: work
      done: finalize
    max_iterations: 3
  - id: finalize
    type: agent
    agent: merger
    task: "FINALIZE"
`;
    const t = tracker();
    const g = globalThis as Record<string, unknown>;
    g.__e2eCapChecks = 0;
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<capped>"),
      agents: AGENTS,
      codeHandlers: {
        check: `export default async () => { globalThis.__e2eCapChecks++; return { branch: "again" }; };`,
      },
      responder: (task) => {
        if (/WORK/.test(task)) return ok("worked");
        if (/FINALIZE/.test(task)) return ok("finalized");
        return ok("default");
      },
      onAgentStarted: t.onAgentStarted,
      onAgentComplete: t.onAgentComplete,
    });
    const checks = g.__e2eCapChecks;
    delete g.__e2eCapChecks;

    expect(result.status).toBe("success");
    // 1 initial pass + exactly max_iterations (3) re-entries, then the cap forces exit.
    expect(t.count("work")).toBe(4);
    expect(checks).toBe(4);
    // Forced exit falls through to the next step.
    expect(result.results.finalize.summary).toBe("finalized");
    expect(t.log.lastIndexOf("done:work")).toBeLessThan(t.log.indexOf("start:finalize"));
  });

  it("exits early (without hitting the cap) when the handler returns the exit branch", async () => {
    const yaml = `name: converges
description: loop that converges on pass 2
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK pass \${{loop.check.iteration}}"
  - id: check
    type: code-decision
    blockedBy: [work]
    inputs:
      last: "\${{result.work.summary}}"
    branches:
      again: work
      done: finalize
    max_iterations: 5
  - id: finalize
    type: agent
    agent: merger
    task: "FINALIZE last=[\${{result.work.fullOutput}}]"
`;
    const t = tracker();
    let pass = 0;
    let finalizeTask = "";
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<converges>"),
      agents: AGENTS,
      codeHandlers: { check: `export default async (i) => ({ branch: i.last === "good" ? "done" : "again" });` },
      responder: (task) => {
        if (/WORK/.test(task)) { ++pass; return reply(`prose of pass ${pass}`, pass >= 2 ? "good" : "bad"); }
        finalizeTask = task;
        return ok("finalized");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("success");
    expect(t.count("work")).toBe(2);
    expect(result.results.finalize.status).toBe("complete");
    // The body's reply text after the loop is the LAST pass's.
    expect(finalizeTask).toContain("FINALIZE last=[prose of pass 2]");
  });
});

describe("e2e faux DAG: failure model", () => {
  const withOnError = `name: soft
description: worker fails, recovery runs
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN"
  - id: build
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "BUILD"
    on_error: recover
  - id: publish
    type: agent
    agent: merger
    blockedBy: [build]
    task: "PUBLISH"
  - id: recover
    type: agent
    agent: merger
    blockedBy: [build]
    task: "RECOVER from \${{result.build.summary}}"
`;
  const failing = (task: string) => {
    if (/BUILD/.test(task)) return scriptFinish({ status: "error", summary: "compile exploded" });
    if (/RECOVER/.test(task)) return ok(`recovered: ${task}`);
    return ok("fine");
  };

  it("with on_error: a failing worker routes to the recovery step and the flow continues", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(withOnError, "<soft>"),
      agents: AGENTS, responder: failing,
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.results.build.status).toBe("error");
    expect(result.results.recover.status).toBe("complete");
    expect(result.results.recover.summary).toContain("compile exploded");
    // The normal continuation is not taken: only steps reachable from the on_error target run.
    expect(t.started("publish")).toBe(false);
    expect(result.results.publish.status).toBe("skipped");
    expect(result.status).not.toBe("error");
  });

  it("without on_error: the flow hard-fails and no later step is started", async () => {
    const yaml = `name: halt
description: worker fails with no on_error
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN"
  - id: build
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "BUILD"
  - id: publish
    type: agent
    agent: merger
    blockedBy: [build]
    task: "PUBLISH"
  - id: announce
    type: agent
    agent: merger
    blockedBy: [publish]
    task: "ANNOUNCE"
`;
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<halt>"),
      agents: AGENTS, responder: failing,
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("error");
    expect(result.results.build.status).toBe("error");
    expect(t.started("plan")).toBe(true);
    expect(t.started("publish")).toBe(false);
    expect(t.started("announce")).toBe(false);
    expect(result.results.publish?.status ?? "skipped").not.toBe("complete");
  });

  it("FlowHardError thrown by a code handler stops the flow even when on_error is declared", async () => {
    const yaml = `name: hard
description: hard error beats on_error
steps:
  - id: check
    type: code
    on_error: recover
  - id: after
    type: agent
    agent: worker
    blockedBy: [check]
    task: "AFTER"
  - id: recover
    type: agent
    agent: worker
    task: "RECOVER"
`;
    const t = tracker();
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<hard>"),
      agents: AGENTS,
      codeHandlers: {
        // Handlers are loaded by dynamic import, so the engine recognises the error by name.
        check: `class FlowHardError extends Error { constructor(m) { super(m); this.name = "FlowHardError"; } }
export default async () => { throw new FlowHardError("credentials revoked"); };`,
      },
      responder: () => ok("should not run"),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.output + JSON.stringify(result.results.check ?? {})).toContain("credentials revoked");
    expect(t.started("recover")).toBe(false);
    expect(t.started("after")).toBe(false);
  });

  it("a plain throw in a code handler IS soft: it routes to on_error", async () => {
    const yaml = `name: softcode
description: plain throw routes to on_error
steps:
  - id: check
    type: code
    on_error: recover
  - id: recover
    type: agent
    agent: worker
    task: "RECOVER"
`;
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<softcode>"),
      agents: AGENTS,
      codeHandlers: { check: `export default async () => { throw new Error("flaky"); };` },
      responder: () => ok("recovered"),
    });
    expect(result.results.recover.status).toBe("complete");
    expect(result.status).not.toBe("error");
  });
});

describe("e2e faux DAG: typed flow inputs", () => {
  const YAML = `name: typed
description: typed inputs end to end
inputs:
  ticket: { type: string, required: true }
  retries: { type: number }
  labels: { type: array }
steps:
  - id: triage
    type: agent
    agent: worker
    task: "TRIAGE \${{flow.input.ticket}}"
  - id: plan
    type: code
    blockedBy: [triage]
    inputs:
      retries: "\${{flow.input.retries}}"
      labels: "\${{flow.input.labels}}"
    outputs:
      - name: total
      - name: first
      - name: kind
  - id: report
    type: agent
    agent: merger
    blockedBy: [plan]
    task: "REPORT total=\${{result.plan.total}} labels=\${{flow.input.labels}}"
`;
  const HANDLER = `export default async (input) => ({
  total: input.retries * 2,
  first: input.labels[0],
  kind: typeof input.retries + "/" + Array.isArray(input.labels),
});`;

  it("a missing required input refuses the run before any agent is spawned", async () => {
    const t = tracker();
    let spawned = 0;
    const result = await runFauxFlow({
      flow: parseFlowYamlString(YAML, "<typed>"),
      agents: AGENTS,
      codeHandlers: { plan: HANDLER },
      responder: () => { spawned++; return ok("x"); },
      flowInput: { retries: 2 },
      onAgentStarted: t.onAgentStarted,
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.output).toContain("missing required input");
    expect(result.lastResult.output).toContain("ticket");
    expect(spawned).toBe(0);
    expect(t.log).toEqual([]);
  });

  it("a type mismatch refuses the run", async () => {
    let spawned = 0;
    const result = await runFauxFlow({
      flow: parseFlowYamlString(YAML, "<typed>"),
      agents: AGENTS,
      codeHandlers: { plan: HANDLER },
      responder: () => { spawned++; return ok("x"); },
      flowInput: { ticket: "T-1", retries: "two" },
    });
    expect(result.status).toBe("error");
    expect(spawned).toBe(0);
  });

  it("provided inputs: ${{flow.input.x}} in an agent task, typed delivery to a code handler", async () => {
    const tasks: Record<string, string> = {};
    const result = await runFauxFlow({
      flow: parseFlowYamlString(YAML, "<typed>"),
      agents: AGENTS,
      codeHandlers: { plan: HANDLER },
      responder: (task) => {
        const key = task.match(/TRIAGE|REPORT/)![0];
        tasks[key] = task;
        return ok(`${key} ok`);
      },
      flowInput: { ticket: "T-42", retries: 3, labels: ["bug", "p1"] },
    });
    expect(result.status).toBe("success");
    expect(tasks.TRIAGE).toContain("TRIAGE T-42");
    // Whole-value reference → real JSON types reach the handler.
    expect(result.results.plan.outputs.total).toBe(6);
    expect(result.results.plan.outputs.first).toBe("bug");
    expect(result.results.plan.outputs.kind).toBe("number/true");
    // Embedded reference in text → JIT-serialised compact JSON.
    expect(tasks.REPORT).toContain("total=6");
    expect(tasks.REPORT).toContain('labels=["bug","p1"]');
  });
});
