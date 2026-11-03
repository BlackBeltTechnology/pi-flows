/**
 * End-to-end faux scenarios for decision-agent selection and decision routing
 * (spec: decision-routing). Flows/agents are authored as YAML/markdown,
 * validated, parsed, then run on the real runFlow with the faux provider.
 *
 * Selection chain (first match wins):
 *   step `agent:` > flow `decision_agent:` > settings `flows.decisionAgent`
 *   > built-in `flow-decision` (the real agents/flow-decision.md from disk)
 *
 * NOTE: sequential agent steps need `blockedBy` — steps without it run in
 * parallel inside one DAG segment.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish, scriptSlowText } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";

const agentMd = (name: string, model: string | null = "faux/faux-1") =>
  `---\nname: ${name}\ndescription: ${name} agent\n${model ? `model: ${model}\n` : ""}tools: read\n---\n\nYou are ${name}.\n`;

const here = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DECISION_MD = readFileSync(join(here, "..", "agents", "flow-decision.md"), "utf8");

/** Validate authored files (flow validated against the given agent catalog), then parse them. */
function author(flowYaml: string, agentMds: string[]) {
  const agents = agentMds.map((m) => parseAgentString(m, "<e2e>"));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const diag = validateFlowContent(flowYaml, () => byName, () => true);
  expect(diag.diagnostics.filter((d) => d.severity === "error"), "flow validates").toEqual([]);
  for (const md of agentMds) {
    expect(validateAgentContent(md).diagnostics.filter((d) => d.severity === "error"), md).toEqual([]);
  }
  return { flow: parseFlowYamlString(flowYaml, "<e2e>"), agents };
}

/** Same, but skip catalog validation (for flows that deliberately name missing agents). */
function authorUnchecked(flowYaml: string, agentMds: string[]) {
  return { flow: parseFlowYamlString(flowYaml, "<e2e>"), agents: agentMds.map((m) => parseAgentString(m, "<e2e>")) };
}

interface Started { name: string; step: string; extra: any }

/** Observers shared by every scenario. */
function observe() {
  const started: Started[] = [];
  const tasks: Array<{ step: string; task: string }> = [];
  return {
    started, tasks,
    onAgentStarted: (name: string, step: string, _m?: string, extra?: any) => started.push({ name, step, extra }),
    /** Who decided at `step`. */
    who: (step: string) => started.filter((s) => s.step === step).map((s) => s.name),
  };
}

// ── 1. The selection chain ────────────────────────────────────────────────

const CHAIN_FLOW = `name: chain
description: three decision points over one flow decision_agent
decision_agent: flow-router
steps:
  - id: start
    type: agent
    agent: worker
    task: "START \${{task}}"
  - id: d1
    type: agent-decision
    agent: step-judge
    task: "DECIDE-1 go or stop?"
    branches:
      go: mid
      stop: end
  - id: mid
    type: agent
    agent: worker
    task: "MID"
  - id: d2
    type: agent-decision
    task: "DECIDE-2 go or stop?"
    branches:
      go: fk
      stop: end
  - id: fk
    type: fork
    question: "Ship or hold? FORKQ"
    options: [ship, hold]
    branches:
      ship: ship
      hold: end
  - id: ship
    type: agent
    agent: worker
    task: "SHIP"
  - id: end
    type: agent
    agent: worker
    task: "END"
    blockedBy: [ship]
`;

/** Decision responder: every decision says "go"/"ship"; workers just finish. */
const chainResponder = (t: string) => {
  if (/DECIDE-1|DECIDE-2/.test(t)) return scriptFinish({ status: "complete", summary: "decided", branch: "go" });
  if (/The user was asked/.test(t)) return scriptFinish({ status: "complete", summary: "decided", branch: "ship" });
  const marker = /\b(START|MID|SHIP|END)\b/.exec(t)?.[1] ?? "?";
  return scriptFinish({ status: "complete", summary: `${marker} done` });
};

const CHAIN_AGENTS = ["worker", "step-judge", "flow-router", "settings-router", "flow-decision"].map((n) => agentMd(n));

describe("e2e faux: decision agent selection chain", () => {
  it("step agent > flow decision_agent > settings: each decision point uses the first configured agent", async () => {
    const { flow, agents } = author(CHAIN_FLOW, CHAIN_AGENTS);
    const o = observe();
    const events: DecisionEvent[] = [];
    const decisionTasks: string[] = [];
    const result = await runFaux({
      flow, agents,
      responder: (t) => { if (/DECIDE|The user was asked/.test(t)) decisionTasks.push(t); return chainResponder(t); },
      decisionAgent: "settings-router", // lower priority than the flow's decision_agent
      isAutonomous: () => true,
      onAgentStarted: o.onAgentStarted,
      onDecision: (e) => events.push(e),
    });

    expect(result.status).toBe("success");
    // The whole path ran: go → go → ship, then the join.
    for (const id of ["start", "mid", "ship", "end"]) expect(result.results[id].status).toBe("complete");

    expect(o.who("d1")).toEqual(["step-judge"]);   // step agent wins over flow + settings
    expect(o.who("d2")).toEqual(["flow-router"]);  // flow decision_agent beats settings
    expect(o.who("fk")).toEqual(["flow-router"]);  // an autonomous fork uses the same chain
    for (const never of ["settings-router", "flow-decision"]) {
      expect(o.started.map((s) => s.name)).not.toContain(never);
    }
    expect(events.map((e) => [e.stepId, e.nodeKind, e.routedBy, e.label])).toEqual([
      ["d1", "agent-decision", "agent", "go"],
      ["d2", "agent-decision", "agent", "go"],
      ["fk", "fork", "agent", "ship"],
    ]);
    // Each decision agent's task is its expanded task followed by the branch list
    // (labels only: no branch declares `means`); no `state:` → no State section.
    const HEAD = "Branches (call finish with exactly one of these as `branch`):";
    expect(decisionTasks).toHaveLength(3);
    expect(decisionTasks[0]).toContain(`DECIDE-1 go or stop?\n\n${HEAD}\n- go\n- stop`);
    expect(decisionTasks[1]).toContain(`DECIDE-2 go or stop?\n\n${HEAD}\n- go\n- stop`);
    expect(decisionTasks[2]).toContain("Ship or hold? FORKQ");
    expect(decisionTasks[2]).toContain(`${HEAD}\n- ship\n- hold`);
    for (const t of decisionTasks) expect(t).not.toContain("State:");
  });

  it("settings decisionAgent applies when neither step nor flow names one (runFaux decisionAgent option)", async () => {
    const yaml = CHAIN_FLOW.replace("decision_agent: flow-router\n", "").replace("    agent: step-judge\n", "");
    const { flow, agents } = author(yaml, CHAIN_AGENTS);
    expect(flow.decision_agent).toBeUndefined();
    const o = observe();
    const result = await runFaux({
      flow, agents, responder: chainResponder,
      decisionAgent: "settings-router", isAutonomous: () => true, onAgentStarted: o.onAgentStarted,
    });
    expect(result.status).toBe("success");
    expect(result.results.ship.status).toBe("complete");
    expect(o.who("d1")).toEqual(["settings-router"]);
    expect(o.who("d2")).toEqual(["settings-router"]);
    expect(o.who("fk")).toEqual(["settings-router"]);
  });

  it("built-in flow-decision (the real agents/flow-decision.md) decides when nothing is configured; it runs on the session model", async () => {
    // The shipped agent is valid and declares an @-ref (no resolver in this run).
    expect(validateAgentContent(BUILTIN_DECISION_MD).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const builtin = parseAgentString(BUILTIN_DECISION_MD, "agents/flow-decision.md");
    expect(builtin.name).toBe("flow-decision");
    expect(builtin.modelRefs).toEqual(["@fast"]);

    const yaml = CHAIN_FLOW.replace("decision_agent: flow-router\n", "").replace("    agent: step-judge\n", "");
    const { flow } = author(yaml, CHAIN_AGENTS);
    const agents = [agentMd("worker"), BUILTIN_DECISION_MD].map((m) => parseAgentString(m, "<e2e>"));
    const o = observe();
    const served: string[] = [];
    const result = await runFaux({
      flow, agents,
      responder: (t, model) => { if (/DECIDE|The user was asked/.test(t)) served.push(model?.id); return chainResponder(t); },
      isAutonomous: () => true, onAgentStarted: o.onAgentStarted,
    });
    expect(result.status).toBe("success");
    expect(result.results.ship.status).toBe("complete");
    expect(o.who("d1")).toEqual(["flow-decision"]);
    expect(o.who("d2")).toEqual(["flow-decision"]);
    expect(o.who("fk")).toEqual(["flow-decision"]);
    // @fast with no resolver → parent session model, reported as a fallback.
    expect(served).toEqual(["faux-1", "faux-1", "faux-1"]);
    expect(o.started.find((s) => s.step === "d1")!.extra.modelFallback)
      .toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "no-resolver" });
  });
});

// ── 2. Missing / branchless decision agents ───────────────────────────────

const ROUTE_FLOW = (head: string, stepAgent: string, onError: boolean) => `name: route
description: one decision point with a recovery step
${head}steps:
  - id: prep
    type: agent
    agent: worker
    task: "PREP"
  - id: route
    type: agent-decision
${stepAgent}    task: "DECIDE the route"
    branches:
      left: left
      right: right
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
    task: "FALLBACK after \${{result.prep.summary}}"
    blockedBy: [prep]
`;

/** `branch` undefined → the decision agent just talks and never calls finish with a branch. */
const routeResponder = (branch?: string) => (t: string) => {
  // (the stop-gate reminder after a no-finish turn carries no task text, so match it too)
  if (/DECIDE|You did not call/.test(t)) {
    return branch ? scriptFinish({ status: "complete", summary: "thought about it", branch }) : scriptSlowText("I think probably left, but I will not commit to it.");
  }
  const marker = /\b(PREP|LEFT|RIGHT|FALLBACK)\b/.exec(t)?.[1] ?? "?";
  return scriptFinish({ status: "complete", summary: `${marker} done` });
};

describe("e2e faux: configured decision agent is missing", () => {
  const cases: Array<{ label: string; head: string; stepAgent: string; settings?: string; name: string; where: RegExp }> = [
    { label: "settings decisionAgent", head: "", stepAgent: "", settings: "nope", name: "nope", where: /flows\.decisionAgent/ },
    { label: "flow decision_agent", head: "decision_agent: ghost-router\n", stepAgent: "", name: "ghost-router", where: /decision_agent/ },
    { label: "step agent", head: "", stepAgent: "    agent: phantom\n", name: "phantom", where: /step's agent/ },
  ];

  for (const c of cases) {
    it(`${c.label}: the step fails naming the agent and where it was configured; on_error routes on`, async () => {
      const { flow, agents } = authorUnchecked(ROUTE_FLOW(c.head, c.stepAgent, true), [agentMd("worker")]);
      const o = observe();
      const served: string[] = [];
      const result = await runFaux({
        flow, agents, decisionAgent: c.settings,
        responder: (t) => { served.push(/DECIDE/.test(t) ? "DECIDE" : t); return routeResponder("left")(t); },
        onAgentStarted: o.onAgentStarted,
      });

      expect(result.status).toBe("success");
      expect(result.results.route.status).toBe("error");
      expect(result.results.route.summary).toContain(c.name);
      expect(result.results.route.summary).toMatch(c.where);
      // on_error → fallback ran; neither branch target did (no default branch).
      expect(result.results.fallback.summary).toBe("FALLBACK done");
      expect(result.results.left.status).toBe("skipped");
      expect(result.results.right.status).toBe("skipped");
      expect(served).not.toContain("DECIDE");
    });
  }

  it("without on_error the flow halts with an error naming the agent; nothing after the decision runs", async () => {
    const { flow, agents } = authorUnchecked(ROUTE_FLOW("", "", false), [agentMd("worker")]);
    const started: string[] = [];
    const result = await runFaux({
      flow, agents, decisionAgent: "nope", responder: routeResponder("left"),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toContain("nope");
    expect(started).not.toContain("left");
    expect(started).not.toContain("fallback");
  });
});

describe("e2e faux: agent-decision that finishes without a valid branch", () => {
  it("a decision agent that never produces a branch fails the step (no first-branch default); on_error routes", async () => {
    const { flow, agents } = author(ROUTE_FLOW("decision_agent: judge\n", "", true), [agentMd("worker"), agentMd("judge")]);
    const events: DecisionEvent[] = [];
    const started: string[] = [];
    const result = await runFaux({
      flow, agents, responder: routeResponder(undefined), // answers in prose, never calls finish with a branch
      onDecision: (e) => events.push(e),
      onAgentStarted: (_n, step) => started.push(step),
    });

    expect(result.status).toBe("success");
    expect(result.results.route.status).toBe("error");
    expect(result.results.route.summary).toMatch(/no decider produced/i);
    expect(result.results.fallback.summary).toBe("FALLBACK done");
    // The first branch ("left") is NOT silently chosen.
    expect(started).not.toContain("left");
    expect(result.results.left.status).toBe("skipped");
    expect(events).toHaveLength(1);
    expect(events[0].routedBy).toBeUndefined();
    expect(events[0].label).toBeUndefined();
    expect(events[0].attempts.every((a) => a.outcome !== "ok")).toBe(true);
  });

  it("an off-map branch label is rejected by the finish tool; the agent corrects itself and the valid label routes", async () => {
    const { flow, agents } = author(ROUTE_FLOW("decision_agent: judge\n", "", false), [agentMd("worker"), agentMd("judge")]);
    const started: string[] = [];
    const events: DecisionEvent[] = [];
    const decisionTurns: string[] = [];
    const result = await runFaux({
      flow, agents,
      responder: (t) => {
        if (!/DECIDE/.test(t)) return routeResponder("right")(t);
        decisionTurns.push(t);
        // first attempt names a branch that does not exist, the retry picks a real one
        return scriptFinish({ status: "complete", summary: "x", branch: decisionTurns.length === 1 ? "maybe" : "right" });
      },
      onDecision: (e) => events.push(e),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(decisionTurns.length).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("success");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stepId: "route", routedBy: "agent", label: "right" });
    expect(result.results.right.summary).toBe("RIGHT done");
    expect(result.results.left.status).toBe("skipped");
    expect(started).not.toContain("fallback");
  });

  for (const status of ["blocked", "error"] as const) {
    it(`a decision agent that finishes with status "${status}" does not route even though it names a branch; on_error routes`, async () => {
      const { flow, agents } = author(ROUTE_FLOW("decision_agent: judge\n", "", true), [agentMd("worker"), agentMd("judge")]);
      const events: DecisionEvent[] = [];
      const started: string[] = [];
      const result = await runFaux({
        flow, agents,
        responder: (t) => /DECIDE/.test(t)
          ? scriptFinish({ status, summary: "cannot tell from here", branch: "left" })
          : routeResponder("left")(t),
        onDecision: (e) => events.push(e),
        onAgentStarted: (_n, step) => started.push(step),
      });
      expect(result.status).toBe("success");
      expect(result.results.route.status).toBe("error");
      expect(result.results.route.summary).toContain(`the decision agent finished with status ${status}`);
      expect(result.results.fallback.summary).toBe("FALLBACK done");
      // The branch it named is NOT taken.
      expect(started).not.toContain("left");
      expect(result.results.left.status).toBe("skipped");
      expect(result.results.right.status).toBe("skipped");
      expect(events).toHaveLength(1);
      expect(events[0].routedBy).toBeUndefined();
      expect(events[0].label).toBeUndefined();
      expect(events[0].attempts).toHaveLength(1);
      expect(events[0].attempts[0].entry).toBe("agent");
      expect(events[0].attempts[0].outcome).not.toBe("ok");
      expect(events[0].attempts[0].reason).toBe(`the decision agent finished with status ${status}`);
    });
  }

  it("a blocked decision agent without on_error halts the flow; nothing after it runs", async () => {
    const { flow, agents } = author(ROUTE_FLOW("decision_agent: judge\n", "", false), [agentMd("worker"), agentMd("judge")]);
    const started: string[] = [];
    const result = await runFaux({
      flow, agents,
      responder: (t) => /DECIDE/.test(t) ? scriptFinish({ status: "blocked", summary: "need input", branch: "right" }) : routeResponder("right")(t),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toContain("the decision agent finished with status blocked");
    for (const id of ["left", "right", "fallback"]) expect(started).not.toContain(id);
  });

  it("without on_error an unanswered decision halts the flow; nothing after it runs", async () => {
    const { flow, agents } = author(ROUTE_FLOW("decision_agent: judge\n", "", false), [agentMd("worker"), agentMd("judge")]);
    const started: string[] = [];
    const result = await runFaux({
      flow, agents, responder: routeResponder(undefined),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toMatch(/no decider produced/i);
    for (const id of ["left", "right", "fallback"]) expect(started).not.toContain(id);
  });
});

// ── 3. Forks ──────────────────────────────────────────────────────────────

const FORK_FLOW = (decisionAgent: string, forkAgent: string, allowCustom = false) => `name: fork-flow
description: choose an approach
${decisionAgent}steps:
  - id: choose
    type: fork
    question: "Which approach? APPROACHQ"
    options: [Quick fix, Full refactor]
    branches:
      Quick fix: quick
      Full refactor: refactor
${forkAgent}${allowCustom ? "    allowCustom: true\n" : ""}  - id: quick
    type: agent
    agent: worker
    task: "QUICK path"
  - id: refactor
    type: agent
    agent: worker
    task: "REFACTOR path"
`;

const forkResponder = (t: string) => {
  if (/The user was asked/.test(t)) {
    const typed = /custom answer[^"]*"([^"]*)"/.exec(t)?.[1];
    // Free text → closest branch; otherwise this decider always prefers the big option.
    const branch = typed !== undefined ? (/patch|small|hotfix/i.test(typed) ? "Quick fix" : "Full refactor") : "Full refactor";
    return scriptFinish({ status: "complete", summary: "picked", branch });
  }
  return scriptFinish({ status: "complete", summary: `${/QUICK|REFACTOR/.exec(t)?.[0] ?? "?"} done` });
};

describe("e2e faux: forks", () => {
  it("autonomous fork is decided by the flow decision_agent without asking the user", async () => {
    const { flow, agents } = author(FORK_FLOW("decision_agent: flow-router\n", ""), [agentMd("worker"), agentMd("flow-router")]);
    const o = observe();
    let asked = 0;
    const answers: unknown[] = [];
    const result = await runFaux({
      flow, agents, responder: forkResponder,
      isAutonomous: () => true,
      askUser: async (q) => { asked++; answers.push(q); return { answer: "Quick fix" }; },
      onAgentStarted: o.onAgentStarted,
    });
    expect(asked).toBe(0);
    expect(result.status).toBe("success");
    expect(o.who("choose")).toEqual(["flow-router"]);
    expect(result.forks.choose.answer).toBe("Full refactor");
    expect(result.results.refactor.summary).toBe("REFACTOR done");
    expect(result.results.quick.status).toBe("skipped");
  });

  it("interactive fork is answered by askUser; no decision agent runs", async () => {
    const { flow, agents } = author(FORK_FLOW("decision_agent: flow-router\n", ""), [agentMd("worker"), agentMd("flow-router")]);
    const o = observe();
    const asked: Array<{ question: string; type: string; options?: string[] }> = [];
    const result = await runFaux({
      flow, agents, responder: forkResponder,
      isAutonomous: () => false,
      askUser: async (question, type, options) => { asked.push({ question, type, options }); return { answer: "Quick fix", notes: "keep it small" }; },
      onAgentStarted: o.onAgentStarted,
    });
    expect(asked).toEqual([{ question: "Which approach? APPROACHQ", type: "select", options: ["Quick fix", "Full refactor"] }]);
    expect(result.status).toBe("success");
    expect(result.forks.choose).toEqual({ answer: "Quick fix", notes: "keep it small" });
    expect(result.results.quick.summary).toBe("QUICK done");
    expect(result.results.refactor.status).toBe("skipped");
    expect(o.started.map((s) => s.name)).not.toContain("flow-router");
  });

  it("\"Other\" free text on an interactive fork is mapped to a branch by the fork's decision agent", async () => {
    const { flow, agents } = author(
      FORK_FLOW("decision_agent: flow-router\n", "    agent: fork-router\n", true),
      [agentMd("worker"), agentMd("flow-router"), agentMd("fork-router")],
    );
    const o = observe();
    const decisionTasks: string[] = [];
    const result = await runFaux({
      flow, agents,
      responder: (t) => { if (/The user was asked/.test(t)) decisionTasks.push(t); return forkResponder(t); },
      isAutonomous: () => false,
      askUser: async (_q, _t, _o, extra) => {
        expect(extra?.hasAutoAgent).toBe(true);
        expect(extra?.allowCustom).toBe(true);
        return { answer: "__custom_decide__", notes: "just a small hotfix please" };
      },
      onAgentStarted: o.onAgentStarted,
    });
    expect(result.status).toBe("success");
    // The fork's own agent (step > flow) decided, and saw the typed text.
    // (the fork card is announced under the fork's agent, then the agent spawns once to decide)
    expect(new Set(o.who("choose"))).toEqual(new Set(["fork-router"]));
    expect(o.started.map((s) => s.name)).not.toContain("flow-router");
    expect(decisionTasks).toHaveLength(1);
    expect(decisionTasks[0]).toContain("just a small hotfix please");
    expect(decisionTasks[0]).toContain("Branches (call finish with exactly one of these as `branch`):\n- Quick fix\n- Full refactor");
    // "small hotfix" mapped to the Quick fix branch; the notes travel with the fork answer.
    expect(result.forks.choose).toEqual({ answer: "Quick fix", notes: "just a small hotfix please" });
    expect(result.results.quick.summary).toBe("QUICK done");
    expect(result.results.refactor.status).toBe("skipped");
  });

  it("allowCustom with only a flow decision_agent: Other + Auto-decide are offered and the flow agent maps the text", async () => {
    const { flow, agents } = author(FORK_FLOW("decision_agent: flow-router\n", "", true), [agentMd("worker"), agentMd("flow-router")]);
    const o = observe();
    const extras: any[] = [];
    const result = await runFaux({
      flow, agents, responder: forkResponder,
      isAutonomous: () => false,
      askUser: async (_q, _t, _o, extra) => { extras.push(extra); return { answer: "__custom_decide__", notes: "a tiny patch" }; },
      onAgentStarted: o.onAgentStarted,
    });
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({ hasAutoAgent: true, allowCustom: true });
    expect(result.status).toBe("success");
    expect(o.started.filter((s) => s.step === "choose").map((s) => s.name)).toContain("flow-router");
    expect(result.forks.choose).toEqual({ answer: "Quick fix", notes: "a tiny patch" });
    expect(result.results.quick.summary).toBe("QUICK done");
  });

  it("allowCustom with nothing that routes it validates with a warning (not an error) naming flows.decider", () => {
    const yaml = FORK_FLOW("", "", true);
    const agents = new Map([agentMd("worker")].map((m) => { const a = parseAgentString(m, "<e2e>"); return [a.name, a]; }));
    const diags = validateFlowContent(yaml, () => agents, () => true).diagnostics.filter((d) => /allowCustom/.test(d.message));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(`${diags[0].message} ${diags[0].suggestion ?? ""}`).toMatch(/flows\.decider/);
    // ... and a flow decision_agent silences it.
    const withAgent = validateFlowContent(FORK_FLOW("decision_agent: flow-router\n", "", true), () => agents, () => true);
    expect(withAgent.diagnostics.filter((d) => /allowCustom/.test(d.message))).toEqual([]);
  });

  it("an autonomous fork whose decision agent finishes \"blocked\" (with a branch) fails instead of routing", async () => {
    const { flow, agents } = author(FORK_FLOW("decision_agent: flow-router\n", ""), [agentMd("worker"), agentMd("flow-router")]);
    const events: DecisionEvent[] = [];
    const result = await runFaux({
      flow, agents,
      responder: (t) => /The user was asked/.test(t) ? scriptFinish({ status: "blocked", summary: "unsure", branch: "Quick fix" }) : forkResponder(t),
      isAutonomous: () => true,
      onDecision: (e) => events.push(e),
    });
    expect(result.status).toBe("error");
    expect(result.results.quick?.status ?? "skipped").not.toBe("complete");
    expect(result.results.refactor?.status ?? "skipped").not.toBe("complete");
    expect(events).toHaveLength(1);
    expect(events[0].routedBy).toBeUndefined();
    expect(events[0].attempts[0].reason).toBe("the decision agent finished with status blocked");
  });

  it("\"Other\" free text the decider cannot map re-asks the user instead of defaulting a branch", async () => {
    const { flow, agents } = author(
      FORK_FLOW("", "    agent: fork-router\n", true),
      [agentMd("worker"), agentMd("fork-router")],
    );
    const replies = [{ answer: "__custom_decide__", notes: "???" }, { answer: "Full refactor" }];
    let asked = 0;
    const result = await runFaux({
      flow, agents,
      responder: (t) => /The user was asked|You did not call/.test(t)
        ? scriptSlowText("no idea, sorry") // prose only: the decider yields no branch
        : forkResponder(t),
      isAutonomous: () => false,
      askUser: async () => replies[asked++],
    });
    expect(asked).toBe(2);
    expect(result.status).toBe("success");
    expect(result.forks.choose.answer).toBe("Full refactor");
    expect(result.results.refactor.summary).toBe("REFACTOR done");
    expect(result.results.quick.status).toBe("skipped");
  });
});

// ── 4. Verify/fix loop with a decider that never says "done" ──────────────

const LOOP_FLOW = `name: verify-fix
description: implement, verify, and loop until clean (capped)
decision_agent: judge
steps:
  - id: implement
    type: agent
    agent: coder
    task: "IMPLEMENT pass \${{loop.gate.iteration}}"
  - id: verify
    type: agent
    agent: coder
    task: "VERIFY pass \${{loop.gate.iteration}}"
    blockedBy: [implement]
  - id: gate
    type: agent-decision
    task: "GATE pass \${{loop.gate.iteration}}/\${{loop.gate.max}}: ok?"
    branches:
      fix: implement
      done: report
    max_iterations: 2
  - id: report
    type: agent
    agent: coder
    task: "REPORT after \${{result.verify.summary}}"
    blockedBy: [verify]
`;

describe("e2e faux: verify/fix loop cap", () => {
  it("a decider that always says \"fix\": the loop edge is taken exactly max_iterations times, then the flow falls through to the exit step", async () => {
    const { flow, agents } = author(LOOP_FLOW, [agentMd("coder"), agentMd("judge")]);
    const tasks: Array<{ step: string; task: string }> = [];
    const events: DecisionEvent[] = [];
    const completed: string[] = [];
    const result = await runFaux({
      flow, agents, maxTurns: 48,
      responder: (t) => {
        if (/GATE/.test(t)) { tasks.push({ step: "gate", task: t }); return scriptFinish({ status: "complete", summary: "not clean", branch: "fix" }); }
        const step = /\b(IMPLEMENT|VERIFY|REPORT)\b/.exec(t)?.[1] ?? "?";
        tasks.push({ step, task: t });
        return scriptFinish({ status: "complete", summary: `${step.toLowerCase()} ${/pass (\d+)/.exec(t)?.[1] ?? ""}`.trim() });
      },
      onDecision: (e) => events.push(e),
      onAgentComplete: (_a, step) => completed.push(step),
    });

    expect(result.status).toBe("success");
    // The backward edge was taken exactly `max_iterations` (2) times: first pass + 2 re-entries.
    // (max_iterations caps loop-backs, see code-decision.test.ts: "1 initial pass + 3 backward loops".)
    expect(completed.filter((s) => s === "implement")).toHaveLength(3);
    expect(completed.filter((s) => s === "verify")).toHaveLength(3);
    expect(completed.filter((s) => s === "gate")).toHaveLength(3);
    // Cap reached → forced exit falls through to the next step in file order.
    expect(completed.filter((s) => s === "report")).toHaveLength(1);
    expect(completed[completed.length - 1]).toBe("report");
    expect(result.results.report.summary).toBe("report");
    // The decider said "fix" every time — including the last decision, which the cap turned into an exit.
    expect(events.map((e) => e.label)).toEqual(["fix", "fix", "fix"]);
    // The report saw the LAST iteration's verify result.
    expect(tasks.find((t) => t.step === "REPORT")!.task).toContain("verify 3");
  });

  it("${{loop.gate.iteration}} is 1-based and body and decision agree within a pass", async () => {
    const { flow, agents } = author(LOOP_FLOW, [agentMd("coder"), agentMd("judge")]);
    const seen: string[] = [];
    await runFaux({
      flow, agents, maxTurns: 48,
      responder: (t) => {
        if (/GATE/.test(t)) { seen.push(/GATE pass (\d+)\/(\d+)/.exec(t)!.slice(1).join("/")); return scriptFinish({ status: "complete", summary: "x", branch: "fix" }); }
        if (/IMPLEMENT|VERIFY/.test(t)) seen.push(/(IMPLEMENT|VERIFY) pass (\d+)/.exec(t)!.slice(1).join(":"));
        return scriptFinish({ status: "complete", summary: "ok" });
      },
    });
    expect(seen).toEqual([
      "IMPLEMENT:1", "VERIFY:1", "1/2",  // pass 1 (never 0)
      "IMPLEMENT:2", "VERIFY:2", "2/2",  // pass 2: body and decision both observe 2
      "IMPLEMENT:3", "VERIFY:3", "3/2",  // pass 3: still in lock-step; the cap then forces the exit
    ]);
  });

  it("a judge that finishes \"blocked\" on pass 2 (still naming `fix`) stops the loop: no re-entry, no fall-through", async () => {
    const { flow, agents } = author(LOOP_FLOW, [agentMd("coder"), agentMd("judge")]);
    const completed: string[] = [];
    const gateTasks: string[] = [];
    const events: DecisionEvent[] = [];
    const result = await runFaux({
      flow, agents, maxTurns: 48,
      responder: (t) => {
        if (/GATE/.test(t)) {
          gateTasks.push(t);
          return gateTasks.length === 1
            ? scriptFinish({ status: "complete", summary: "needs work", branch: "fix" })
            : scriptFinish({ status: "blocked", summary: "cannot verify", branch: "fix" });
        }
        return scriptFinish({ status: "complete", summary: "ok" });
      },
      onDecision: (e) => events.push(e),
      onAgentComplete: (_a, step) => completed.push(step),
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toContain("the decision agent finished with status blocked");
    // pass 1 looped; pass 2's blocked "fix" was NOT a loop-back and NOT the cap's fall-through.
    expect(completed.filter((s) => s === "implement")).toHaveLength(2);
    expect(completed).not.toContain("report");
    expect(events.map((e) => [e.label, e.routedBy])).toEqual([["fix", "agent"], [undefined, undefined]]);
    // The gate task carries the branch list on every pass.
    for (const t of gateTasks) expect(t).toContain("Branches (call finish with exactly one of these as `branch`):\n- fix\n- done");
  });

  it("exits through the done branch as soon as the decider says so (loop not exhausted)", async () => {
    const { flow, agents } = author(LOOP_FLOW, [agentMd("coder"), agentMd("judge")]);
    const completed: string[] = [];
    let gates = 0;
    const result = await runFaux({
      flow, agents, maxTurns: 48,
      responder: (t) => {
        if (/GATE/.test(t)) return scriptFinish({ status: "complete", summary: "x", branch: ++gates === 1 ? "done" : "fix" });
        return scriptFinish({ status: "complete", summary: "ok" });
      },
      onAgentComplete: (_a, step) => completed.push(step),
    });
    expect(result.status).toBe("success");
    expect(completed).toEqual(["implement", "verify", "gate", "report"]);
  });
});
