/**
 * End-to-end faux scenarios for `fork` steps — part 1: interactive prompts.
 * (docs/flows.md › Fork Step, Fork free text, Decider chain.)
 *
 * Flows/agents are authored as YAML/markdown, validated, parsed, then run on
 * the real runFlow with the faux provider. Responders route on task text
 * (markers `@@NAME`, or the decision-agent branch list), never call order.
 *
 * Fork context lands in the branch step's SYSTEM prompt (docs: "automatically
 * injected into the branch step's system prompt"), which runFaux's responder
 * does not see — `runSys` below is a runFaux twin whose responder also gets the
 * system prompt.
 */
import { describe, expect, it } from "vitest";
import {
  makeFauxRegistry, registerFauxOnRuntime, lastUserText,
  runFaux, scriptFinish, scriptSlowText, type FauxResponseStep, type RunFauxOptions,
} from "./faux-harness.js";
import { runFlow } from "../extensions/flow-engine/flow-execution.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { DecisionEvent, FlowResult } from "../extensions/flow-engine/types.js";
import type { ClassifierEntry, DecisionQuestion, EntryResult } from "../extensions/flow-engine/decider/types.js";

const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n`;

function author(flowYaml: string, agentNames: string[]) {
  const mds = agentNames.map(agentMd);
  const agents = mds.map((m) => parseAgentString(m, "<e2e>"));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const diag = validateFlowContent(flowYaml, () => byName, () => true);
  expect(diag.diagnostics.filter((d) => d.severity === "error"), "flow validates").toEqual([]);
  for (const md of mds) expect(validateAgentContent(md).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return { flow: parseFlowYamlString(flowYaml, "<e2e>"), agents };
}

const DECISION = /Branches \(call finish|You did not call/;
const marker = (t: string) => /@@([A-Z0-9-]+)/.exec(t)?.[1] ?? "?";
const work = (t: string) => scriptFinish({ status: "complete", summary: `${marker(t)} done` });

/** Decision turns answer `pick(task)` (a branch, or undefined → prose, no finish); workers finish. */
const respond = (pick: (t: string) => string | undefined) => (t: string): FauxResponseStep => {
  if (!DECISION.test(t)) return work(t);
  const b = pick(t);
  return b ? scriptFinish({ status: "complete", summary: "decided", branch: b }) : scriptSlowText("I would rather not choose.");
};

interface Ask { question: string; type: string; options?: string[]; extra: any }
type Reply = { answer: string | string[]; notes?: string };

/** Interactive stub: records every prompt, answers via `reply(question, callIndex)`. */
function asker(reply: (q: string, n: number) => Reply) {
  const asks: Ask[] = [];
  return {
    asks,
    askUser: async (question: string, type: string, options?: string[], extra?: any) => {
      asks.push({ question, type, options, extra });
      return reply(question, asks.length - 1) as { answer: string; notes?: string };
    },
  };
}

const cls = (label: string, seen: DecisionQuestion[]): ClassifierEntry => async (q) => {
  seen.push(q);
  return { ok: true, answer: { label, confidence: 0.99 } } as EntryResult;
};

/** runFaux twin whose responder also receives the agent's system prompt. */
async function runSys(
  o: Omit<RunFauxOptions, "responder"> & { responder: (task: string, system: string) => FauxResponseStep },
): Promise<FlowResult> {
  const { faux, runtime } = await registerFauxOnRuntime({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });
  // The agent's system prompt arrives as a `system` message whose text lives in `content` + `sections`.
  const systemText = (context: any): string => (context?.messages ?? [])
    .filter((m: any) => m.role === "system")
    .map((m: any) => [typeof m.content === "string" ? m.content : "", ...Object.values(m.sections ?? {})].join("\n"))
    .join("\n");
  const factory = (context: any): any => o.responder(lastUserText(context), systemText(context));
  faux.setResponses(Array.from({ length: o.maxTurns ?? 24 }, () => factory));
  const registry = makeFauxRegistry(faux);
  const byName = new Map(o.agents.map((a) => [a.name, a]));
  try {
    return await runFlow({
      flow: o.flow, task: o.task ?? "flow task", cwd: process.cwd(),
      modelRegistry: registry, modelRuntime: runtime,
      pi: { events: { emit: () => undefined, on: () => undefined }, modelRegistry: registry } as any,
      getAgent: (n: string) => byName.get(n),
      askUser: o.askUser ?? (async () => ({ answer: "" })),
      isAutonomous: o.isAutonomous, decider: o.decider, decisionAgent: o.decisionAgent,
      entryOverrides: o.entryOverrides, onDecision: o.onDecision, onAgentStarted: o.onAgentStarted,
      parentModel: { model: faux.getModel("faux-1") as any },
    });
  } finally {
    faux.unregister();
  }
}

// ── Flow fixtures ──────────────────────────────────────────────────────────

/** scan → fork (templated question) → one of three deploy targets. */
const DEPLOY = (forkExtra = "", head = "") => `name: deploy
description: scan the service then choose where to deploy
${head}steps:
  - id: scan
    type: agent
    agent: worker
    task: "@@SCAN the service"
  - id: target
    type: fork
    blockedBy: [scan]
    question: "Deploy \${{task}}? Scan said: \${{result.scan.summary}}"
    options: [Staging, Production, Canary]
    branches:
      Staging: staging
      Production: production
      Canary: canary
${forkExtra}  - id: staging
    type: agent
    agent: worker
    task: "@@STAGING deploy"
  - id: production
    type: agent
    agent: worker
    task: "@@PRODUCTION deploy"
  - id: canary
    type: agent
    agent: worker
    task: "@@CANARY deploy"
`;

/** Pick a deploy target from a decision task (works for typed free text too). */
const deployPick = (t: string) => {
  const typed = /custom answer[^"]*"([^"]*)"/.exec(t)?.[1] ?? "";
  if (/live|everyone|prod/i.test(typed)) return "Production";
  if (/few|percent|slice/i.test(typed)) return "Canary";
  return "Staging";
};

const ran = (r: FlowResult, id: string) => r.results[id]?.status === "complete";

// ── 1. Interactive single select ───────────────────────────────────────────

describe("e2e faux forks: interactive select", () => {
  it("the chosen option routes to its branch; the others are skipped; the question is template-expanded", async () => {
    const { flow, agents } = author(DEPLOY(), ["worker"]);
    const a = asker(() => ({ answer: "Production" }));
    const r = await runFaux({ flow, agents, task: "billing-api v2", responder: respond(deployPick), askUser: a.askUser });

    expect(r.status).toBe("success");
    expect(a.asks).toHaveLength(1);
    expect(a.asks[0].question).toBe("Deploy billing-api v2? Scan said: SCAN done");
    expect(a.asks[0].type).toBe("select");
    expect(a.asks[0].options).toEqual(["Staging", "Production", "Canary"]);
    expect(r.results.production.summary).toBe("PRODUCTION done");
    expect(r.results.staging.status).toBe("skipped");
    expect(r.results.canary.status).toBe("skipped");
    expect(r.forks.target).toEqual({ answer: "Production" });
  });

  it("a plain fork passes branches but no multiSelect / allowCustom / hasAutoAgent", async () => {
    const { flow, agents } = author(DEPLOY(), ["worker"]);
    const a = asker(() => ({ answer: "Staging" }));
    await runFaux({ flow, agents, responder: respond(deployPick), askUser: a.askUser });
    expect(a.asks[0].extra).toEqual({ branches: { Staging: "staging", Production: "production", Canary: "canary" } });
  });

  it("allowCustom + multiSelect + step agent: every flag reaches askUser", async () => {
    const { flow, agents } = author(
      DEPLOY("    multiSelect: true\n    allowCustom: true\n    agent: router\n"), ["worker", "router"],
    );
    const a = asker(() => ({ answer: ["Canary"] }));
    await runFaux({ flow, agents, responder: respond(deployPick), askUser: a.askUser });
    expect(a.asks[0].extra).toMatchObject({ multiSelect: true, allowCustom: true, hasAutoAgent: true });
    expect(a.asks[0].extra.branches).toEqual({ Staging: "staging", Production: "production", Canary: "canary" });
  });

  it("the user's pick and notes are injected into the branch step's system prompt only", async () => {
    const { flow, agents } = author(DEPLOY(), ["worker"]);
    const systems: Record<string, string> = {};
    const r = await runSys({
      flow, agents,
      responder: (t, sys) => { systems[marker(t)] = sys; return work(t); },
      askUser: async () => ({ answer: "Canary", notes: "5% of traffic first" }),
    });
    expect(r.status).toBe("success");
    expect(systems.CANARY).toContain("User Decision: target");
    expect(systems.CANARY).toContain("Selected: Canary");
    expect(systems.CANARY).toContain("Notes: 5% of traffic first");
    expect(systems.SCAN).not.toContain("User Decision");
    expect(Object.keys(systems).sort()).toEqual(["CANARY", "SCAN"]);
  });
});

// ── 2. multiSelect ─────────────────────────────────────────────────────────

const AUDIT = `name: audit
description: pick which audits to run, then report
steps:
  - id: which
    type: fork
    question: "Which audits for \${{task}}?"
    multiSelect: true
    options: [Security, Performance, Accessibility]
    branches:
      Security: security
      Performance: perf
      Accessibility: a11y
  - id: security
    type: agent
    agent: auditor
    task: "@@SECURITY audit"
  - id: perf
    type: agent
    agent: auditor
    task: "@@PERF audit"
  - id: a11y
    type: agent
    agent: auditor
    task: "@@A11Y audit"
`;

describe("e2e faux forks: multiSelect", () => {
  it("every selected option runs its branch, in selection order, before anything else", async () => {
    const { flow, agents } = author(AUDIT, ["auditor"]);
    const started: string[] = [];
    const a = asker(() => ({ answer: ["Security", "Accessibility"] }));
    const r = await runFaux({
      flow, agents, task: "the checkout page", responder: respond(() => undefined), askUser: a.askUser,
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(r.status).toBe("success");
    expect(a.asks[0].question).toBe("Which audits for the checkout page?");
    expect(a.asks[0].extra.multiSelect).toBe(true);
    expect(started.slice(0, 3)).toEqual(["which", "security", "a11y"]);
    expect(r.results.security.summary).toBe("SECURITY done");
    expect(r.results.a11y.summary).toBe("A11Y done");
    expect(r.forks.which.answer).toEqual(["Security", "Accessibility"]);
  });

  // ENGINE BUG: after a multiSelect fork runs its selected branches it falls through file order and re-runs every branch step (unselected included).
  it.fails("the unselected branch never runs and each selected branch runs exactly once", async () => {
    const { flow, agents } = author(AUDIT, ["auditor"]);
    const started: string[] = [];
    const r = await runFaux({
      flow, agents, responder: respond(() => undefined),
      askUser: async () => ({ answer: ["Security", "Accessibility"] as any }),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(started).not.toContain("perf");
    expect(ran(r, "perf")).toBe(false);
    // each selected branch ran exactly once
    expect(started.filter((s) => s === "security")).toHaveLength(1);
    expect(started.filter((s) => s === "a11y")).toHaveLength(1);
  });

  it("each selected branch receives the fork context (all selected options + notes)", async () => {
    const { flow, agents } = author(AUDIT, ["auditor"]);
    const systems: Record<string, string> = {};
    await runSys({
      flow, agents,
      // first run of each branch (see the ENGINE BUG above for the re-runs)
      responder: (t, sys) => { systems[marker(t)] ??= sys; return work(t); },
      askUser: async () => ({ answer: ["Security", "Performance"] as any, notes: "release blocker" }),
    });
    for (const m of ["SECURITY", "PERF"]) {
      expect(systems[m]).toContain("User Decision: which");
      expect(systems[m]).toContain("Selected: Security, Performance");
      expect(systems[m]).toContain("Notes: release blocker");
    }
  });
});

// ── 3. allowCustom "Other (describe)" ──────────────────────────────────────

const OTHER = { answer: "__custom_decide__", notes: "ship it live to everyone" };

describe("e2e faux forks: Other free text", () => {
  it("step agent: the fork's agent receives the typed text and routes; notes travel to the branch", async () => {
    const { flow, agents } = author(DEPLOY("    allowCustom: true\n    agent: router\n"), ["worker", "router"]);
    const decisionTasks: string[] = [];
    const who: Array<[string, string]> = [];
    const systems: Record<string, string> = {};
    const a = asker(() => OTHER);
    const r = await runSys({
      flow, agents, askUser: a.askUser,
      onAgentStarted: (n, s) => who.push([n, s]),
      responder: (t, sys) => {
        if (DECISION.test(t)) decisionTasks.push(t);
        else systems[marker(t)] = sys;
        return respond(deployPick)(t);
      },
    });
    expect(r.status).toBe("success");
    expect(a.asks).toHaveLength(1);
    expect(a.asks[0].extra).toMatchObject({ allowCustom: true, hasAutoAgent: true });
    expect(decisionTasks).toHaveLength(1);
    expect(decisionTasks[0]).toContain("ship it live to everyone");
    expect(who.filter(([, s]) => s === "target").map(([n]) => n)).toContain("router");
    expect(r.forks.target).toEqual({ answer: "Production", notes: "ship it live to everyone" });
    expect(ran(r, "production")).toBe(true);
    expect(ran(r, "staging")).toBe(false);
    expect(systems.PRODUCTION).toContain("Notes: ship it live to everyone");
    expect(systems.PRODUCTION).toContain("Decided by: router");
  });

  it("step decider chain: a classifier gets the typed text as userText and routes without an agent", async () => {
    const { flow, agents } = author(
      DEPLOY("    allowCustom: true\n    decider: [system-one, agent]\n"), ["worker", "flow-decision"],
    );
    const seen: DecisionQuestion[] = [];
    const started: string[] = [];
    const events: DecisionEvent[] = [];
    const a = asker(() => ({ answer: "__custom_decide__", notes: "just a small slice of users" }));
    const r = await runFaux({
      flow, agents, askUser: a.askUser, responder: respond(() => "Staging"),
      entryOverrides: { "system-one": cls("Canary", seen) },
      onAgentStarted: (n) => started.push(n), onDecision: (e) => events.push(e),
    });
    expect(r.status).toBe("success");
    expect(a.asks[0].extra.hasAutoAgent).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].state.userText).toBe("just a small slice of users");
    expect(Object.keys(seen[0].question.criteria)).toEqual(["Staging", "Production", "Canary"]);
    expect(started).not.toContain("flow-decision");
    expect(events[0]).toMatchObject({ stepId: "target", nodeKind: "fork", routedBy: "system-one", label: "Canary" });
    expect(ran(r, "canary")).toBe(true);
    expect(r.forks.target).toEqual({ answer: "Canary", notes: "just a small slice of users" });
  });

  it("flow-level decider chain also routes Other (and offers it)", async () => {
    const { flow, agents } = author(
      DEPLOY("    allowCustom: true\n", "decider: [typesafe/jev-latest, agent]\n"), ["worker", "flow-decision"],
    );
    const seen: DecisionQuestion[] = [];
    const a = asker(() => OTHER);
    const r = await runFaux({
      flow, agents, askUser: a.askUser, responder: respond(() => "Staging"),
      entryOverrides: { "typesafe/jev-latest": cls("Production", seen) },
    });
    expect(a.asks[0].extra.hasAutoAgent).toBe(true);
    expect(seen[0].state.userText).toBe("ship it live to everyone");
    expect(ran(r, "production")).toBe(true);
  });

  it("flow decision_agent: that agent maps the typed text to a branch", async () => {
    const { flow, agents } = author(DEPLOY("    allowCustom: true\n", "decision_agent: flow-router\n"), ["worker", "flow-router"]);
    const who: Array<[string, string]> = [];
    const decisionTasks: string[] = [];
    const a = asker(() => ({ answer: "__custom_decide__", notes: "a few percent first" }));
    const r = await runFaux({
      flow, agents, askUser: a.askUser,
      onAgentStarted: (n, s) => who.push([n, s]),
      responder: (t) => { if (DECISION.test(t)) decisionTasks.push(t); return respond(deployPick)(t); },
    });
    expect(r.status).toBe("success");
    expect(a.asks[0].extra).toMatchObject({ allowCustom: true, hasAutoAgent: true });
    expect(who).toContainEqual(["flow-router", "target"]);
    expect(decisionTasks[0]).toContain("a few percent first");
    expect(r.forks.target.answer).toBe("Canary");
    expect(ran(r, "canary")).toBe(true);
  });

  it("settings flows.decider (runFaux decider option) routes Other when the flow declares nothing", async () => {
    const { flow, agents } = author(DEPLOY("    allowCustom: true\n"), ["worker", "flow-decision"]);
    const seen: DecisionQuestion[] = [];
    const a = asker(() => OTHER);
    const r = await runFaux({
      flow, agents, askUser: a.askUser, responder: respond(() => "Staging"),
      decider: { entries: ["system-one"] } as any,
      entryOverrides: { "system-one": cls("Production", seen) },
    });
    expect(a.asks[0].extra.hasAutoAgent).toBe(true);
    expect(seen[0].state.userText).toBe("ship it live to everyone");
    expect(r.forks.target.answer).toBe("Production");
    expect(ran(r, "production")).toBe(true);
  });

  it("nothing routes Other: hasAutoAgent is false and no decision agent ever runs", async () => {
    const { flow, agents } = author(DEPLOY("    allowCustom: true\n"), ["worker", "flow-decision"]);
    const started: string[] = [];
    const a = asker(() => ({ answer: "Staging" }));
    const r = await runFaux({
      flow, agents, askUser: a.askUser, responder: respond(() => "Canary"),
      decisionAgent: "flow-decision", // flows.decisionAgent alone does not make the fork auto-decidable
      onAgentStarted: (n) => started.push(n),
    });
    expect(a.asks[0].extra.hasAutoAgent).toBeUndefined();
    expect(a.asks[0].extra.allowCustom).toBe(true);
    expect(started).not.toContain("flow-decision");
    expect(ran(r, "staging")).toBe(true);
  });

  it("Other text the decider cannot map: the user is asked again with the same question, options and extra", async () => {
    const { flow, agents } = author(DEPLOY("    allowCustom: true\n    agent: router\n"), ["worker", "router"]);
    const a = asker((_q, n) => (n === 0 ? { answer: "__custom_decide__", notes: "hmm, whatever" } : { answer: "Canary" }));
    const r = await runFaux({ flow, agents, task: "svc", askUser: a.askUser, responder: respond(() => undefined) });
    expect(a.asks).toHaveLength(2);
    expect(a.asks[1]).toEqual(a.asks[0]);
    expect(r.status).toBe("success");
    expect(r.forks.target.answer).toBe("Canary");
    expect(ran(r, "canary")).toBe(true);
    expect(ran(r, "staging")).toBe(false);
  });

  it("Other answered by a decision agent that finishes \"blocked\" with a branch: not routed, user re-asked", async () => {
    const { flow, agents } = author(DEPLOY("    allowCustom: true\n    agent: router\n"), ["worker", "router"]);
    const a = asker((_q, n) => (n === 0 ? OTHER : { answer: "Staging" }));
    const events: DecisionEvent[] = [];
    const r = await runFaux({
      flow, agents, askUser: a.askUser, onDecision: (e) => events.push(e),
      responder: (t) => DECISION.test(t)
        ? scriptFinish({ status: "blocked", summary: "cannot decide safely", branch: "Production" })
        : work(t),
    });
    expect(a.asks).toHaveLength(2);
    expect(events[0].label).toBeUndefined();
    expect(ran(r, "production")).toBe(false);
    expect(ran(r, "staging")).toBe(true);
  });
});

// ── 4. Auto-decide ─────────────────────────────────────────────────────────

describe("e2e faux forks: Auto-decide", () => {
  it("__auto_decide__ hands the fork to its agent; the user is asked once", async () => {
    const { flow, agents } = author(DEPLOY("    agent: router\n"), ["worker", "router"]);
    const who: Array<[string, string]> = [];
    const systems: Record<string, string> = {};
    const a = asker(() => ({ answer: "__auto_decide__" }));
    const r = await runSys({
      flow, agents, askUser: a.askUser, onAgentStarted: (n, s) => who.push([n, s]),
      responder: (t, sys) => { if (!DECISION.test(t)) systems[marker(t)] = sys; return respond(() => "Canary")(t); },
    });
    expect(a.asks).toHaveLength(1);
    expect(a.asks[0].extra.hasAutoAgent).toBe(true);
    expect(who.filter(([, s]) => s === "target").map(([n]) => n)).toContain("router");
    expect(r.forks.target.answer).toBe("Canary");
    expect(ran(r, "canary")).toBe(true);
    expect(systems.CANARY).toContain("Auto Decision: target");
    expect(systems.CANARY).toContain("Decided by: router");
  });

  it("__auto_decide__ whose agent yields no branch: user is told and asked again with the same options", async () => {
    const { flow, agents } = author(DEPLOY("    agent: router\n"), ["worker", "router"]);
    const a = asker((_q, n) => (n === 0 ? { answer: "__auto_decide__" } : { answer: "Production" }));
    const r = await runFaux({ flow, agents, task: "svc", askUser: a.askUser, responder: respond(() => undefined) });
    expect(a.asks).toHaveLength(2);
    expect(a.asks[1].question).toBe(a.asks[0].question);
    expect(a.asks[1].options).toEqual(["Staging", "Production", "Canary"]);
    expect(a.asks[1].extra).toEqual(a.asks[0].extra);
    expect(r.status).toBe("success");
    expect(ran(r, "production")).toBe(true);
    for (const id of ["staging", "canary"]) expect(ran(r, id)).toBe(false);
  });

  it("__auto_decide__ answered with status \"error\" + branch is ignored (re-ask), not routed", async () => {
    const { flow, agents } = author(DEPLOY("    agent: router\n"), ["worker", "router"]);
    const a = asker((_q, n) => (n === 0 ? { answer: "__auto_decide__" } : { answer: "Staging" }));
    const r = await runFaux({
      flow, agents, askUser: a.askUser,
      responder: (t) => DECISION.test(t) ? scriptFinish({ status: "error", summary: "broken", branch: "Canary" }) : work(t),
    });
    expect(a.asks).toHaveLength(2);
    expect(ran(r, "canary")).toBe(false);
    expect(ran(r, "staging")).toBe(true);
  });
});
