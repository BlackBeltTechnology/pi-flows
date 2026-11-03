/**
 * End-to-end faux scenarios for `fork` steps — part 2: autonomous decisions,
 * decision failures, forks in larger graphs (loops, fan-in, skipped targets),
 * and the allowCustom validator diagnostic.
 * (docs/flows.md › Fork Step, Decision agent selection, Decider chain, Loops.)
 *
 * Flows/agents are authored as YAML/markdown, validated, parsed, then run on
 * the real runFlow via runFaux. Responders route on task text, never order.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish, scriptSlowText, type FauxResponseStep } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { DecisionEvent, FlowResult } from "../extensions/flow-engine/types.js";

const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n`;

const here = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DECISION_MD = readFileSync(join(here, "..", "agents", "flow-decision.md"), "utf8");

function author(flowYaml: string, agentNames: string[], extraMds: string[] = []) {
  const mds = [...agentNames.map(agentMd), ...extraMds];
  const agents = mds.map((m) => parseAgentString(m, "<e2e>"));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const diag = validateFlowContent(flowYaml, () => byName, () => true);
  expect(diag.diagnostics.filter((d) => d.severity === "error"), "flow validates").toEqual([]);
  for (const md of mds) expect(validateAgentContent(md).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return { flow: parseFlowYamlString(flowYaml, "<e2e>"), agents };
}

const BRANCH_LIST = "Branches (call finish with exactly one of these as `branch`):";
const DECISION = /Branches \(call finish|You did not call/;
const marker = (t: string) => /@@([A-Z0-9-]+)/.exec(t)?.[1] ?? "?";
const work = (t: string) => scriptFinish({ status: "complete", summary: `${marker(t)} done` });
const respond = (pick: (t: string) => string | undefined) => (t: string): FauxResponseStep => {
  if (!DECISION.test(t)) return work(t);
  const b = pick(t);
  return b ? scriptFinish({ status: "complete", summary: "decided", branch: b }) : scriptSlowText("No strong opinion.");
};
const ran = (r: FlowResult, id: string) => r.results[id]?.status === "complete";
const noAsk = () => { throw new Error("autonomous fork must not ask the user"); };

// ── Fixture: triage → fork(severity) → page / ticket / ignore, with recovery ──

const TRIAGE = (o: { head?: string; fork?: string } = {}) => `name: incident
description: triage an alert and route by severity
${o.head ?? ""}steps:
  - id: triage
    type: agent
    agent: worker
    task: "@@TRIAGE alert \${{task}}"
  - id: severity
    type: fork
    blockedBy: [triage]
    question: "How severe is \${{task}}? Triage: \${{result.triage.summary}}"
    options: [page, ticket, ignore]
    branches:
      page: page
      ticket: ticket
      ignore: ignore
${o.fork ?? ""}  - id: page
    type: agent
    agent: worker
    task: "@@PAGE on-call"
  - id: ticket
    type: agent
    agent: worker
    task: "@@TICKET file"
  - id: ignore
    type: agent
    agent: worker
    task: "@@IGNORE log"
  - id: recover
    type: agent
    agent: worker
    task: "@@RECOVER manual triage"
`;

const AGENTS = ["worker", "step-router", "flow-router", "settings-router"];

// ── 1. Autonomous selection chain ──────────────────────────────────────────

describe("e2e faux forks: autonomous decision-agent selection", () => {
  const cases: Array<{ label: string; head?: string; fork?: string; settings?: string; expectAgent: string }> = [
    { label: "step agent beats flow decision_agent and settings", head: "decision_agent: flow-router\n", fork: "    agent: step-router\n", settings: "settings-router", expectAgent: "step-router" },
    { label: "flow decision_agent beats settings", head: "decision_agent: flow-router\n", settings: "settings-router", expectAgent: "flow-router" },
    { label: "settings decisionAgent applies when the flow names none", settings: "settings-router", expectAgent: "settings-router" },
  ];
  for (const c of cases) {
    it(`${c.label}`, async () => {
      const { flow, agents } = author(TRIAGE(c), AGENTS);
      const who: Array<[string, string]> = [];
      const r = await runFaux({
        flow, agents, isAutonomous: () => true, askUser: noAsk, decisionAgent: c.settings,
        responder: respond(() => "ticket"), onAgentStarted: (n, s) => who.push([n, s]),
      });
      expect(r.status).toBe("success");
      expect(who.filter(([, s]) => s === "severity").map(([n]) => n)).toEqual([c.expectAgent]);
      expect(r.forks.severity.answer).toBe("ticket");
      expect(ran(r, "ticket")).toBe(true);
      for (const id of ["page", "ignore", "recover"]) expect(ran(r, id), id).toBe(false);
    });
  }

  it("the built-in flow-decision decides when nothing is configured", async () => {
    const { flow, agents } = author(TRIAGE(), ["worker"], [BUILTIN_DECISION_MD]);
    const who: Array<[string, string]> = [];
    const r = await runFaux({
      flow, agents, isAutonomous: () => true, askUser: noAsk,
      responder: respond(() => "page"), onAgentStarted: (n, s) => who.push([n, s]),
    });
    expect(r.status).toBe("success");
    expect(who.filter(([, s]) => s === "severity").map(([n]) => n)).toEqual(["flow-decision"]);
    expect(ran(r, "page")).toBe(true);
  });
});

// ── 2. What the decision agent sees ────────────────────────────────────────

describe("e2e faux forks: decision agent task", () => {
  it("lists every branch under the finish instruction, plus a State: section with the expanded state values", async () => {
    const { flow, agents } = author(TRIAGE({
      head: "decision_agent: flow-router\n",
      fork: "    state:\n      alert: \"${{task}}\"\n      triage: \"${{result.triage.summary}}\"\n",
    }), AGENTS);
    const tasks: string[] = [];
    const r = await runFaux({
      flow, agents, task: "disk-full on db-3", isAutonomous: () => true, askUser: noAsk,
      responder: (t) => { if (DECISION.test(t)) tasks.push(t); return respond(() => "page")(t); },
    });
    expect(r.status).toBe("success");
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t).toContain(BRANCH_LIST);
    for (const b of ["page", "ticket", "ignore"]) expect(t).toContain(`- ${b}`);
    expect(t).toContain("State:");
    expect(t).toContain("- alert: disk-full on db-3");
    expect(t).toContain("- triage: TRIAGE done");
    // the branch list precedes the state section
    expect(t.indexOf(BRANCH_LIST)).toBeLessThan(t.indexOf("State:"));
  });

  it("without state: no State: section; with a fork task: the expanded task is the instruction", async () => {
    const { flow, agents } = author(TRIAGE({
      head: "decision_agent: flow-router\n",
      fork: "    task: \"@@ROUTER classify ${{task}} given ${{result.triage.summary}}\"\n",
    }), AGENTS);
    const tasks: string[] = [];
    await runFaux({
      flow, agents, task: "cpu spike", isAutonomous: () => true, askUser: noAsk,
      responder: (t) => { if (DECISION.test(t)) tasks.push(t); return respond(() => "ignore")(t); },
    });
    expect(tasks[0]).toContain("@@ROUTER classify cpu spike given TRIAGE done");
    expect(tasks[0]).toContain(BRANCH_LIST);
    expect(tasks[0]).not.toContain("State:");
  });

  it("branch `means` replaces the bare label in the branch list", async () => {
    const yaml = TRIAGE({ head: "decision_agent: flow-router\n" }).replace(
      "      page: page\n      ticket: ticket\n      ignore: ignore\n",
      "      page: { to: page, means: \"customer-facing outage\" }\n      ticket: { to: ticket, means: \"degraded, can wait\" }\n      ignore: { to: ignore, means: \"noise\" }\n",
    );
    const { flow, agents } = author(yaml, AGENTS);
    const tasks: string[] = [];
    const r = await runFaux({
      flow, agents, isAutonomous: () => true, askUser: noAsk,
      responder: (t) => { if (DECISION.test(t)) tasks.push(t); return respond(() => "ticket")(t); },
    });
    expect(tasks[0]).toContain("- page: customer-facing outage");
    expect(tasks[0]).toContain("- ignore: noise");
    expect(ran(r, "ticket")).toBe(true);
  });

  it("a fork without task: shows the decision agent the template-expanded question", async () => {
    const { flow, agents } = author(TRIAGE({ head: "decision_agent: flow-router\n" }), AGENTS);
    const tasks: string[] = [];
    await runFaux({
      flow, agents, task: "cert expiry", isAutonomous: () => true, askUser: noAsk,
      responder: (t) => { if (DECISION.test(t)) tasks.push(t); return respond(() => "ticket")(t); },
    });
    expect(tasks[0]).toContain("How severe is cert expiry? Triage: TRIAGE done");
    expect(tasks[0]).not.toContain("${{");
  });
});

// ── 3. Decision failures ───────────────────────────────────────────────────

describe("e2e faux forks: autonomous decision failures", () => {
  for (const status of ["blocked", "error"] as const) {
    it(`decision agent finishing "${status}" with a branch does NOT route; on_error recovers`, async () => {
      const { flow, agents } = author(TRIAGE({ head: "decision_agent: flow-router\n", fork: "    on_error: recover\n" }), AGENTS);
      const events: DecisionEvent[] = [];
      const r = await runFaux({
        flow, agents, isAutonomous: () => true, askUser: noAsk, onDecision: (e) => events.push(e),
        responder: (t) => DECISION.test(t) ? scriptFinish({ status, summary: "unsure", branch: "page" }) : work(t),
      });
      expect(r.status).toBe("success");
      expect(ran(r, "page")).toBe(false);
      expect(ran(r, "recover")).toBe(true);
      expect(r.results.severity.status).toBe("error");
      expect(events).toHaveLength(1);
      expect(events[0].label).toBeUndefined();
      expect(events[0].attempts.map((a) => a.reason).join(" ")).toContain(`finished with status ${status}`);
    });
  }

  it("decision agent finishing \"blocked\" without on_error halts the flow; no branch runs", async () => {
    const { flow, agents } = author(TRIAGE({ head: "decision_agent: flow-router\n" }), AGENTS);
    const started: string[] = [];
    const r = await runFaux({
      flow, agents, isAutonomous: () => true, askUser: noAsk, onAgentStarted: (_n, s) => started.push(s),
      responder: (t) => DECISION.test(t) ? scriptFinish({ status: "blocked", summary: "need a human", branch: "ignore" }) : work(t),
    });
    expect(r.status).toBe("error");
    for (const id of ["page", "ticket", "ignore", "recover"]) expect(started).not.toContain(id);
  });

  it("a decision agent that never names a branch fails the fork (no first-branch default); on_error routes", async () => {
    const { flow, agents } = author(TRIAGE({ head: "decision_agent: flow-router\n", fork: "    on_error: recover\n" }), AGENTS);
    const r = await runFaux({ flow, agents, isAutonomous: () => true, askUser: noAsk, responder: respond(() => undefined) });
    expect(r.status).toBe("success");
    expect(r.results.severity.summary).toMatch(/no decider produced/i);
    expect(ran(r, "page")).toBe(false);
    expect(ran(r, "recover")).toBe(true);
  });
});

// ── 4. Forks inside larger graphs ──────────────────────────────────────────

const LOOP = `name: draft-loop
description: draft, pick a tone each pass, review, loop until approved
decision_agent: reviewer
steps:
  - id: draft
    type: agent
    agent: writer
    task: "@@DRAFT pass \${{loop.review.iteration}}"
  - id: tone
    type: fork
    blockedBy: [draft]
    question: "Tone for pass \${{loop.review.iteration}} of \${{task}}?"
    options: [formal, casual]
    branches:
      formal: formal
      casual: casual
  - id: formal
    type: agent
    agent: writer
    task: "@@FORMAL rewrite"
  - id: casual
    type: agent
    agent: writer
    task: "@@CASUAL rewrite"
  - id: review
    type: agent-decision
    task: "@@REVIEW pass \${{loop.review.iteration}}/\${{loop.review.max}}"
    branches:
      again: draft
      approved: publish
    max_iterations: 2
  - id: publish
    type: agent
    agent: writer
    task: "@@PUBLISH"
`;

const TWO_FORKS = `name: two-forks
description: the first fork skips a step the second fork could route to
steps:
  - id: first
    type: fork
    question: "Lint first?"
    options: [lint, skip-lint]
    branches:
      lint: lint
      skip-lint: second
  - id: lint
    type: agent
    agent: worker
    task: "@@LINT"
  - id: second
    type: fork
    question: "Ship now?"
    options: [ship, hold]
    branches:
      ship: ship
      hold: hold
  - id: ship
    type: agent
    agent: worker
    task: "@@SHIP"
  - id: hold
    type: agent
    agent: worker
    task: "@@HOLD"
`;

describe("e2e faux forks: forks in larger graphs", () => {
  it("a fork inside a loop body is asked again on every pass, with the pass number in its question", async () => {
    const { flow, agents } = author(LOOP, ["writer", "reviewer"]);
    const questions: string[] = [];
    const completed: string[] = [];
    const r = await runFaux({
      flow, agents, task: "the launch post", maxTurns: 48,
      askUser: async (q) => { questions.push(q); return { answer: /pass 2/.test(q) ? "casual" : "formal" }; },
      responder: respond(() => "again"), // reviewer never approves → cap forces the exit
      onAgentComplete: (_a, s) => completed.push(s),
    });
    expect(r.status).toBe("success");
    // max_iterations: 2 → first pass + 2 re-entries = 3 prompts
    expect(questions).toEqual([
      "Tone for pass 1 of the launch post?",
      "Tone for pass 2 of the launch post?",
      "Tone for pass 3 of the launch post?",
    ]);
    expect(completed.filter((s) => s === "draft")).toHaveLength(3);
    expect(completed.filter((s) => s === "casual")).toHaveLength(1);
    expect(completed.filter((s) => s === "formal")).toHaveLength(2);
    expect(completed.filter((s) => s === "publish")).toHaveLength(1);
    expect(completed[completed.length - 1]).toBe("publish");
  });

  it("a fork inside a loop exits early when the reviewer approves", async () => {
    const { flow, agents } = author(LOOP, ["writer", "reviewer"]);
    const questions: string[] = [];
    const r = await runFaux({
      flow, agents, maxTurns: 48,
      askUser: async (q) => { questions.push(q); return { answer: "casual" }; },
      responder: respond((t) => (/REVIEW pass 2\//.test(t) ? "approved" : "again")),
    });
    expect(r.status).toBe("success");
    expect(questions).toHaveLength(2);
    expect(ran(r, "publish")).toBe(true);
  });

  it("a fork after parallel steps waits for both and sees both results in its question", async () => {
    const yaml = `name: fan-in-fork
description: research two options in parallel, then choose
steps:
  - id: aws
    type: agent
    agent: worker
    task: "@@AWS estimate"
  - id: gcp
    type: agent
    agent: worker
    task: "@@GCP estimate"
  - id: cloud
    type: fork
    blockedBy: [aws, gcp]
    question: "AWS says \${{result.aws.summary}}; GCP says \${{result.gcp.summary}}. Which?"
    options: [AWS, GCP]
    branches:
      AWS: use-aws
      GCP: use-gcp
  - id: use-aws
    type: agent
    agent: worker
    task: "@@USE-AWS"
  - id: use-gcp
    type: agent
    agent: worker
    task: "@@USE-GCP"
`;
    const { flow, agents } = author(yaml, ["worker"]);
    const order: string[] = [];
    const questions: string[] = [];
    const r = await runFaux({
      flow, agents, responder: respond(() => undefined),
      onAgentStarted: (_n, s) => order.push(s),
      askUser: async (q) => { questions.push(q); return { answer: "GCP" }; },
    });
    expect(r.status).toBe("success");
    expect(questions).toEqual(["AWS says AWS done; GCP says GCP done. Which?"]);
    expect(order.indexOf("cloud")).toBeGreaterThan(order.indexOf("aws"));
    expect(order.indexOf("cloud")).toBeGreaterThan(order.indexOf("gcp"));
    expect(ran(r, "use-gcp")).toBe(true);
    expect(r.results["use-aws"].status).toBe("skipped");
  });

  it("a join blocked on a skipped branch target still runs; the skipped result expands to its synthetic value", async () => {
    const yaml = `name: skip-join
description: choose one path, then a join over both
steps:
  - id: plan
    type: fork
    question: "Path for \${{task}}?"
    options: [fast, thorough]
    branches:
      fast: fast
      thorough: thorough
  - id: fast
    type: agent
    agent: worker
    task: "@@FAST"
  - id: thorough
    type: agent
    agent: worker
    task: "@@THOROUGH"
  - id: join
    type: agent
    agent: worker
    blockedBy: [fast, thorough]
    task: "@@JOIN fast=[\${{result.fast.summary}}] thorough=[\${{result.thorough.status}}]"
`;
    const { flow, agents } = author(yaml, ["worker"]);
    const tasks: string[] = [];
    const r = await runFaux({
      flow, agents, askUser: async () => ({ answer: "fast" }),
      responder: (t) => { if (/@@JOIN/.test(t)) tasks.push(t); return work(t); },
    });
    expect(r.status).toBe("success");
    expect(r.results.thorough.status).toBe("skipped");
    expect(ran(r, "join")).toBe(true);
    expect(tasks[0]).toContain("fast=[FAST done]");
    expect(tasks[0]).toContain("thorough=[skipped]");
  });

  it("a second fork whose branch was already skipped by the first: the skipped target does not run", async () => {
    const yaml = TWO_FORKS;
    const { flow, agents } = author(yaml, ["worker"]);
    const questions: string[] = [];
    const started: string[] = [];
    const r = await runFaux({
      flow, agents, responder: work,
      askUser: async (q) => { questions.push(q); return { answer: q === "Lint first?" ? "skip-lint" : "hold" }; },
      onAgentStarted: (_n, s) => started.push(s),
    });
    expect(r.status).toBe("success");
    expect(questions).toEqual(["Lint first?", "Ship now?"]);
    expect(started).not.toContain("lint");
    expect(ran(r, "lint")).toBe(false);
    expect(ran(r, "hold")).toBe(true);
    expect(r.results.ship.status).toBe("skipped");
  });

  // ENGINE BUG: when a fork's chosen branch target is another fork, the unselected branch gets no synthetic "skipped" result (it does when the target is an agent).
  it.fails("the first fork's unselected branch is recorded as skipped even when the chosen target is a fork", async () => {
    const { flow, agents } = author(TWO_FORKS, ["worker"]);
    const r = await runFaux({
      flow, agents, responder: work,
      askUser: async (q) => ({ answer: q === "Lint first?" ? "skip-lint" : "hold" }),
    });
    expect(r.results.lint?.status).toBe("skipped");
  });
});

// ── 5. Validator: allowCustom without a router ─────────────────────────────

describe("e2e faux forks: allowCustom validation", () => {
  const diagnose = (yaml: string) => {
    const byName = new Map(AGENTS.map((n) => [n, parseAgentString(agentMd(n), "<e2e>")]));
    return validateFlowContent(yaml, () => byName, () => true).diagnostics.filter((d) => /allowCustom|custom answer/i.test(d.message));
  };

  it("allowCustom with nothing routing it is a WARNING (not an error) that mentions flows.decider", () => {
    const d = diagnose(TRIAGE({ fork: "    allowCustom: true\n" }));
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
    expect(d[0].message).toContain("flows.decider");
    expect(d[0].message).toContain("severity");
  });

  const routed: Array<[string, { head?: string; fork?: string }]> = [
    ["flow decision_agent:", { head: "decision_agent: flow-router\n", fork: "    allowCustom: true\n" }],
    ["step agent:", { fork: "    allowCustom: true\n    agent: step-router\n" }],
    ["step decider:", { fork: "    allowCustom: true\n    decider: [system-one, agent]\n" }],
    ["flow decider:", { head: "decider: [agent]\n", fork: "    allowCustom: true\n" }],
  ];
  for (const [label, o] of routed) {
    it(`allowCustom routed by ${label} produces no diagnostic`, () => {
      expect(diagnose(TRIAGE(o))).toEqual([]);
    });
  }
});
