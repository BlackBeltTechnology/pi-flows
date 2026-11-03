/**
 * End-to-end faux failure scenarios (part 2): abort, on_error target rules,
 * parallel branches with a failing sibling, decision agents that finish
 * blocked/error, failures inside a loop body, and model-resolution failures.
 *
 * Written from docs/flows.md (Failure Modes, Decider chain, Loops, Agent Step
 * `on_error`), docs/flow-authoring.md ("on_error ... can jump to any step ID"),
 * docs/agents.md (literal model refs, flows.modelFallback) and
 * docs/architecture.md (hard-fail halt reuses the abort path). Flows are YAML,
 * agents are markdown; both are validated, parsed and run on the real runFlow
 * with the faux provider. Responders route on the dispatched task text.
 */
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish, scriptSlowText } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import type { AgentConfig, AgentResult } from "../extensions/flow-engine/types.js";

const agentMd = (name: string, model = "faux/faux-1") =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\ntools: read\n---\n\nYou are ${name}.\n`;

const AGENTS: AgentConfig[] = ["planner", "worker", "merger", "rescuer", "reporter", "coder", "reviewer", "judge"]
  .map((n) => parseAgentString(agentMd(n), "<e2e-failures-2>"));
const agentMap = (agents = AGENTS) => () => new Map(agents.map((a) => [a.name, a]));

function validated(yaml: string, agents = AGENTS) {
  const diag = validateFlowContent(yaml, agentMap(agents));
  expect(diag.diagnostics.filter((d) => d.severity === "error"), yaml).toEqual([]);
  return parseFlowYamlString(yaml, "<e2e-failures-2>");
}

const ok = (summary: string, extra: Record<string, unknown> = {}) =>
  scriptFinish({ status: "complete", summary, ...extra });
const fail = (summary: string) => scriptFinish({ status: "error", summary });

function tracker() {
  const starts: string[] = [];
  const done: Record<string, AgentResult> = {};
  return {
    starts,
    done,
    count: (id: string) => starts.filter((s) => s === id).length,
    ran: (id: string) => starts.includes(id),
    onAgentStarted: (_a: string, step: string) => { starts.push(step); },
    onAgentComplete: (_a: string, step: string, r: AgentResult) => { done[step] = r; },
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe("e2e faux failures 2: abort via AbortSignal", () => {
  const FLOW = `name: abortable
description: plan, a long build, then ship
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
    on_error: rescue
  - id: ship
    type: agent
    agent: reporter
    blockedBy: [build]
    task: "SHIP"
  - id: rescue
    type: agent
    agent: rescuer
    blockedBy: [build]
    task: "RESCUE"
`;

  it("aborting mid-step cancels the flow: status aborted, completed work kept, later steps (and on_error) never run", async () => {
    const ac = new AbortController();
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW),
      agents: AGENTS,
      signal: ac.signal,
      onAgentStarted: t.onAgentStarted,
      onAgentComplete: t.onAgentComplete,
      responder: (task) => {
        if (/BUILD/.test(task)) {
          ac.abort(); // the user hits Ctrl+X while the build agent is streaming
          return scriptSlowText("compiling… ".repeat(50));
        }
        return ok(`done ${task}`);
      },
    });
    expect(result.status).toBe("aborted");
    expect(result.results.plan.status).toBe("complete");
    expect(t.ran("ship")).toBe(false);
    expect(t.ran("rescue")).toBe(false);
    expect(result.results.build?.status).not.toBe("complete");
  });

  it("a signal aborted before the run starts dispatches no agent", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const t = tracker();
    await runFaux({
      flow: validated(FLOW),
      agents: AGENTS,
      signal: ac.signal,
      onAgentStarted: t.onAgentStarted,
      responder: () => { calls++; return ok("x"); },
    });
    expect(calls).toBe(0);
    expect(t.starts).toEqual([]);
  });

  // docs: a cancelled run ends with status "aborted".
  it("a signal aborted before the run starts ends the flow with status aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const result = await runFaux({
      flow: validated(FLOW),
      agents: AGENTS,
      signal: ac.signal,
      responder: () => { calls++; return ok("x"); },
    });
    expect(result.status).toBe("aborted");
    expect(calls).toBe(0);
  });

  it("aborting during a parallel wave cancels the siblings too; the fan-in never starts", async () => {
    const yaml = `name: abort-wave
description: three workers then merge
steps:
  - id: w1
    type: agent
    agent: worker
    task: "WORK-1"
  - id: w2
    type: agent
    agent: worker
    task: "WORK-2"
  - id: w3
    type: agent
    agent: worker
    task: "WORK-3"
  - id: merge
    type: agent
    agent: merger
    blockedBy: [w1, w2, w3]
    task: "MERGE"
`;
    const ac = new AbortController();
    const t = tracker();
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      signal: ac.signal,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => {
        if (/WORK-2/.test(task)) { ac.abort(); return scriptSlowText("slow "); }
        if (/WORK/.test(task)) return scriptSlowText("thinking "); // never finishes on its own turn
        return ok(task);
      },
    });
    expect(result.status).toBe("aborted");
    expect(t.ran("merge")).toBe(false);
    for (const w of ["w1", "w2", "w3"]) expect(result.results[w]?.status).not.toBe("complete");
  });
});

describe("e2e faux failures 2: on_error target rules", () => {
  it("validator rejects an on_error that names an unknown step", () => {
    const yaml = `name: bad-target
description: on_error typo
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
    on_error: recoverr
  - id: recover
    type: agent
    agent: rescuer
    task: "RECOVER"
`;
    const diags = validateFlowContent(yaml, agentMap()).diagnostics.filter((d) => d.severity === "error");
    expect(diags.some((d) => /on_error references unknown step ID "recoverr"/.test(d.message))).toBe(true);
  });

  it("on_error to a LATER step skips everything in between (only steps reachable from the target run)", async () => {
    const yaml = `name: skip-ahead
description: build fails, jump to cleanup
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
    on_error: cleanup
  - id: test
    type: agent
    agent: worker
    blockedBy: [build]
    task: "TEST"
  - id: package
    type: agent
    agent: worker
    blockedBy: [test]
    task: "PACKAGE"
  - id: cleanup
    type: agent
    agent: rescuer
    blockedBy: [build]
    task: "CLEANUP after \${{result.build.summary}}"
  - id: notify
    type: agent
    agent: reporter
    blockedBy: [cleanup]
    task: "NOTIFY"
`;
    const t = tracker();
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => (/BUILD/.test(task) ? fail("disk full") : ok(`ok ${task}`)),
    });
    expect(result.status).toBe("success");
    expect(t.starts).toEqual(["build", "cleanup", "notify"]);
    expect(result.results.test.status).toBe("skipped");
    expect(result.results.package.status).toBe("skipped");
    expect(result.results.cleanup.summary).toContain("disk full");
  });

  it("on_error to a later step across a decision node jumps over the decision", async () => {
    const yaml = `name: jump-segments
description: build fails before the gate; on_error lands after it
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
    on_error: postmortem
  - id: gate
    type: agent-decision
    agent: judge
    task: "GATE"
    branches:
      ship: release
      hold: postmortem
  - id: release
    type: agent
    agent: reporter
    task: "RELEASE"
  - id: postmortem
    type: agent
    agent: rescuer
    task: "POSTMORTEM \${{result.build.status}}"
`;
    const t = tracker();
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => (/BUILD/.test(task) ? fail("broken") : /GATE/.test(task) ? ok("g", { branch: "ship" }) : ok(task)),
    });
    expect(result.status).toBe("success");
    expect(t.starts).toEqual(["build", "postmortem"]);
    expect(result.results.postmortem.summary).toContain("POSTMORTEM error");
  });

  it("on_error to an EARLIER step in a previous segment re-runs from there (a retry loop)", async () => {
    const yaml = `name: retry-back
description: build failures go back to prep
steps:
  - id: prep
    type: agent
    agent: planner
    task: "PREP"
  - id: gate
    type: agent-decision
    agent: judge
    task: "GATE"
    branches:
      go: build
      stop: ship
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
    on_error: prep
  - id: ship
    type: agent
    agent: reporter
    blockedBy: [build]
    task: "SHIP \${{result.build.summary}}"
`;
    let builds = 0;
    const t = tracker();
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => {
        if (/BUILD/.test(task)) return ++builds < 3 ? fail("flaky") : ok("built on attempt 3");
        if (/GATE/.test(task)) return ok("go", { branch: "go" });
        return ok(task);
      },
    });
    expect(result.status).toBe("success");
    expect(t.count("prep")).toBe(3);
    expect(t.count("build")).toBe(3);
    expect(t.count("ship")).toBe(1);
    expect(result.results.ship.summary).toContain("built on attempt 3");
    // NOTE: unlike a backward decision branch, a backward on_error edge has no
    // max_iterations cap; it loops for as long as the step keeps failing.
  });

  // ENGINE BUG: on_error pointing at an earlier step in the SAME DAG segment is a no-op —
  // the target is not re-run, the failed step's dependents still run, and the flow reports success.
  it.fails("on_error to an earlier step in the same DAG segment does not let the failed step's dependent run", async () => {
    const yaml = `name: same-segment-back
description: build failure points back at prep
steps:
  - id: prep
    type: agent
    agent: planner
    task: "PREP"
  - id: build
    type: agent
    agent: worker
    blockedBy: [prep]
    task: "BUILD"
    on_error: prep
  - id: ship
    type: agent
    agent: reporter
    blockedBy: [build]
    task: "SHIP"
`;
    const t = tracker();
    let builds = 0;
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => (/BUILD/.test(task) ? (++builds === 1 ? fail("flaky") : ok("built")) : ok(task)),
    });
    // Either the edge is honoured (prep re-runs before ship) or ship must not run on a failed build.
    const shipIdx = t.starts.indexOf("ship");
    const prepReruns = t.count("prep") > 1;
    expect(shipIdx === -1 || prepReruns).toBe(true);
    expect(result.results.ship?.status === "complete" && result.results.build.status === "error").toBe(false);
  });
});

describe("e2e faux failures 2: parallel branches with a failing sibling", () => {
  const FLOW = (onError: boolean) => `name: fanout
description: planner, three workers, merge
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN"
  - id: w1
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "WORK-1"
${onError ? "    on_error: fix-w1\n" : ""}  - id: w2
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "WORK-2"
  - id: w3
    type: agent
    agent: worker
    blockedBy: [plan]
    task: "WORK-3"
  - id: merge
    type: agent
    agent: merger
    blockedBy: [w1, w2, w3]
    task: "MERGE \${{result.w1.status}}/\${{result.w2.status}}/\${{result.w3.status}}"
${onError ? `  - id: fix-w1
    type: agent
    agent: rescuer
    blockedBy: [w1]
    task: "FIX-W1 \${{result.w1.summary}}"
` : ""}`;
  const responder = (task: string) => {
    if (/WORK-1/.test(task)) return fail("w1 crashed");
    if (/WORK-(\d)/.test(task)) return ok(`w${task.match(/WORK-(\d)/)![1]} ok`);
    return ok(`done <${task}>`);
  };

  it("with on_error: siblings in the same wave still complete; the rescue runs; the fan-in is skipped", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW(true)), agents: AGENTS, responder,
      onAgentStarted: t.onAgentStarted,
    });
    expect(result.status).toBe("success");
    expect(result.results.w1.status).toBe("error");
    expect(result.results.w2.status).toBe("complete");
    expect(result.results.w3.status).toBe("complete");
    expect(result.results["fix-w1"].summary).toContain("w1 crashed");
    // merge needs w1, which failed: it is not reachable from the on_error target.
    expect(t.ran("merge")).toBe(false);
    expect(result.results.merge.status).toBe("skipped");
  });

  it("without on_error: the flow halts with error; the fan-in never runs", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW(false)), agents: AGENTS, responder,
      onAgentStarted: t.onAgentStarted,
    });
    expect(result.status).toBe("error");
    expect(result.results.w1.status).toBe("error");
    expect(t.ran("merge")).toBe(false);
    expect(result.lastResult.result.summary).toBeTruthy();
  });
});

// A realistic review loop: implement → review → gate (fix ↺ implement | done → report), on_error → escalate.
const REVIEW_LOOP = (onError: boolean) => `name: review-loop
description: implement, review, gate, loop until clean
steps:
  - id: implement
    type: agent
    agent: coder
    task: "IMPLEMENT pass \${{loop.gate.iteration}}"
  - id: review
    type: agent
    agent: reviewer
    blockedBy: [implement]
    task: "REVIEW \${{result.implement.summary}}"
  - id: gate
    type: agent-decision
    agent: judge
    blockedBy: [review]
    task: "GATE review said: \${{result.review.summary}}"
    branches:
      fix: implement
      done: report
    max_iterations: 3
${onError ? "    on_error: escalate\n" : ""}  - id: report
    type: agent
    agent: reporter
    task: "REPORT"
${onError ? `  - id: escalate
    type: agent
    agent: rescuer
    task: "ESCALATE gate=\${{result.gate.status}} why=\${{result.gate.summary}}"
` : ""}`;

describe("e2e faux failures 2: decision agent finishing blocked/error does not route", () => {
  it("judge finishes blocked WITH branch=done on pass 1 → branch ignored, on_error escalates, report never runs", async () => {
    const t = tracker();
    const decisions: any[] = [];
    const result = await runFaux({
      flow: validated(REVIEW_LOOP(true)),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      onDecision: (e) => decisions.push(e),
      responder: (task) => {
        if (/GATE/.test(task)) return scriptFinish({ status: "blocked", summary: "cannot judge: review empty", branch: "done" });
        if (/ESCALATE/.test(task)) return ok(`escalated <${task}>`);
        return ok(`ok ${task.split(" ")[1]}`);
      },
    });
    expect(t.ran("report")).toBe(false);
    expect(t.ran("escalate")).toBe(true);
    expect(t.count("implement")).toBe(1);
    expect(result.status).toBe("success");
    expect(result.results.report?.status ?? "skipped").toBe("skipped");
    // The ignored branch is a failed decider attempt with the documented reason, visible to the rescue.
    expect(decisions).toHaveLength(1);
    expect(decisions[0].attempts).toEqual([
      expect.objectContaining({ entry: "agent", reason: "the decision agent finished with status blocked" }),
    ]);
    expect(result.results.gate.status).toBe("error");
    expect(result.results.escalate.summary).toContain("gate=error");
    expect(result.results.escalate.summary).toContain("finished with status blocked");
  });

  it("judge finishes error WITH branch=fix and no on_error → no loop-back, the flow halts", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(REVIEW_LOOP(false)),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => {
        if (/GATE/.test(task)) return scriptFinish({ status: "error", summary: "judge crashed", branch: "fix" });
        return ok("fine");
      },
    });
    expect(result.status).toBe("error");
    expect(t.count("implement")).toBe(1); // the fix branch was NOT taken
    expect(t.ran("report")).toBe(false);
    expect(result.lastResult.result.summary).toContain("finished with status error");
  });

  it("judge routes fix on pass 1, then finishes blocked on pass 2 → escalates after exactly one loop-back", async () => {
    let gates = 0;
    const t = tracker();
    const result = await runFaux({
      flow: validated(REVIEW_LOOP(true)),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => {
        if (/GATE/.test(task)) {
          return ++gates === 1
            ? ok("needs a test", { branch: "fix" })
            : scriptFinish({ status: "blocked", summary: "reviewer unreachable", branch: "done" });
        }
        if (/ESCALATE/.test(task)) return ok(`escalated <${task}>`);
        return ok("fine");
      },
    });
    expect(gates).toBe(2);
    expect(t.count("implement")).toBe(2);
    expect(t.ran("report")).toBe(false);
    expect(t.ran("escalate")).toBe(true);
    expect(result.status).toBe("success");
  });

  it("a complete finish with branch=done still routes normally (control case)", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(REVIEW_LOOP(true)),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => (/GATE/.test(task) ? ok("clean", { branch: "done" }) : ok("fine")),
    });
    expect(result.status).toBe("success");
    expect(t.ran("report")).toBe(true);
    expect(t.ran("escalate")).toBe(false);
  });
});

describe("e2e faux failures 2: failure inside a loop body on the 2nd pass", () => {
  /** coder fails on its 2nd pass; judge always asks for a fix. */
  function secondPassFails() {
    let impl = 0;
    return (task: string) => {
      if (/IMPLEMENT/.test(task)) return ++impl === 2 ? fail("pass 2 broke the build") : ok(`impl ${impl}`);
      if (/GATE/.test(task)) return ok("again", { branch: "fix" });
      if (/ESCALATE/.test(task)) return ok(`escalated <${task}>`);
      return ok("reviewed");
    };
  }

  it("without on_error on the body step: the flow halts on pass 2; review/gate/report do not run again", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(REVIEW_LOOP(false)),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      responder: secondPassFails(),
    });
    expect(result.status).toBe("error");
    expect(t.count("implement")).toBe(2);
    expect(t.count("review")).toBe(1);
    expect(t.count("gate")).toBe(1);
    expect(t.ran("report")).toBe(false);
    expect(result.lastResult.result.summary).toContain("pass 2 broke the build");
  });

  it("with on_error on the body step: pass 2's failure routes out of the loop to the rescue", async () => {
    const yaml = REVIEW_LOOP(true).replace(
      '    task: "IMPLEMENT pass ${{loop.gate.iteration}}"\n',
      '    task: "IMPLEMENT pass ${{loop.gate.iteration}}"\n    on_error: escalate\n',
    );
    const t = tracker();
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      maxTurns: 40,
      onAgentStarted: t.onAgentStarted,
      responder: secondPassFails(),
    });
    expect(result.status).toBe("success");
    expect(t.count("implement")).toBe(2);
    expect(t.count("review")).toBe(1);
    expect(t.ran("escalate")).toBe(true);
    expect(t.ran("report")).toBe(false);
    // The rescue reads the latest results: implement failed on its 2nd pass.
    expect(result.results.implement.status).toBe("error");
    expect(result.results.implement.summary).toBe("pass 2 broke the build");
  });
});

describe("e2e faux failures 2: model resolution failures", () => {
  const FLOW = (onError: boolean) => `name: models
description: a step whose agent names a model
steps:
  - id: prep
    type: agent
    agent: planner
    task: "PREP"
  - id: build
    type: agent
    agent: builder
    blockedBy: [prep]
    task: "BUILD"
${onError ? "    on_error: recover\n" : ""}  - id: ship
    type: agent
    agent: reporter
    blockedBy: [build]
    task: "SHIP"
${onError ? `  - id: recover
    type: agent
    agent: rescuer
    blockedBy: [build]
    task: "RECOVER"
` : ""}`;
  const withBuilder = (model: string) => [...AGENTS, parseAgentString(agentMd("builder", model), "<e2e-failures-2>")];
  const responder = (task: string) => ok(`ok ${task}`);

  for (const mode of ["session", "error"] as const) {
    it(`a literal unknown model fails the step even in ${mode} mode; no LLM call; the flow halts`, async () => {
      const t = tracker();
      const seen: string[] = [];
      const result = await runFaux({
        flow: validated(FLOW(false), withBuilder("faux/no-such-model")),
        agents: withBuilder("faux/no-such-model"),
        modelFallback: mode,
        onAgentStarted: t.onAgentStarted,
        onAgentComplete: t.onAgentComplete,
        responder: (task) => { seen.push(task); return responder(task); },
      });
      expect(result.status).toBe("error");
      expect(seen.some((s) => /BUILD/.test(s))).toBe(false);
      expect(t.ran("ship")).toBe(false);
      expect(result.lastResult.result.summary).toContain("no-such-model");
    });
  }

  it("a literal unknown model with on_error routes to the recovery step", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW(true), withBuilder("faux/no-such-model")),
      agents: withBuilder("faux/no-such-model"),
      onAgentStarted: t.onAgentStarted,
      responder,
    });
    expect(result.status).toBe("success");
    expect(result.results.build.status).not.toBe("complete");
    expect(t.ran("recover")).toBe(true);
    expect(t.ran("ship")).toBe(false);
  });

  it("an unresolvable @alias: default session fallback runs the step; strict modelFallback=error fails it", async () => {
    const agents = withBuilder("@nonexistent-role");
    const lenient = await runFaux({ flow: validated(FLOW(false), agents), agents, responder });
    expect(lenient.status).toBe("success");
    expect(lenient.results.build.status).toBe("complete");

    const t = tracker();
    const strict = await runFaux({
      flow: validated(FLOW(false), agents), agents, responder, modelFallback: "error",
      onAgentStarted: t.onAgentStarted,
    });
    expect(strict.status).toBe("error");
    expect(t.ran("ship")).toBe(false);
    expect(strict.lastResult.result.summary).toContain("@nonexistent-role");
  });
});
