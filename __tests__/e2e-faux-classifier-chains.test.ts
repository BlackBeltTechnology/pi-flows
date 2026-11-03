/**
 * End-to-end faux tests for the classifier decider chains (change:
 * classifier-decisions). Each test authors a flow as YAML + agents as markdown,
 * validates and parses them, then runs the REAL `runFlow` with the faux
 * provider. System One and pi-ai classifiers are replaced by fakes through the
 * `entryOverrides` seam; the decision agent is the faux model.
 *
 * Assertions encode the spec (openspec/changes/classifier-decisions) and
 * docs/flows.md "Decider chain", not the implementation.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";
import type { ClassifierEntry, DecisionQuestion, EntryResult } from "../extensions/flow-engine/decider/types.js";

// ---- authoring helpers -----------------------------------------------------

const agentMd = (name: string, outputs = "") =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n${outputs}---\n\nYou are ${name}.\n`;

const AGENT_MDS = [agentMd("worker"), agentMd("judge"), agentMd("reviewer")];

/** Validate (no errors allowed) then parse a YAML flow + the markdown agents. */
function author(yaml: string, mds: string[] = AGENT_MDS) {
  const agents = mds.map((m) => parseAgentString(m, "<e2e>"));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const diag = validateFlowContent(yaml, () => byName, () => true);
  expect(diag.diagnostics.filter((d) => d.severity === "error"), yaml).toEqual([]);
  return { flow: parseFlowYamlString(yaml, "<e2e>"), agents, warnings: diag.diagnostics.filter((d) => d.severity === "warning") };
}

type Asked = DecisionQuestion;
/** A fake classifier that records the question it received. */
const cls = (label: string, confidence: number, seen?: Asked[], extra: Partial<{ mode: "shadow" | "enforce"; calibrated: boolean }> = {}): ClassifierEntry =>
  async (q) => {
    seen?.push(q);
    return { ok: true, calibrated: extra.calibrated, answer: { label, confidence, ...(extra.mode ? { mode: extra.mode } : {}) } } as EntryResult;
  };
const failing = (outcome: "no-backend" | "error" | "credentials" | "off-machine", reason?: string, seen?: Asked[]): ClassifierEntry =>
  async (q) => { seen?.push(q); return { ok: false, outcome, ...(reason ? { reason } : {}) } as EntryResult; };

const ran = (r: any, id: string) => r.results[id]?.status === "complete";
const skipped = (r: any, id: string) => !r.results[id] || r.results[id].status === "skipped";

interface Harness {
  events: DecisionEvent[];
  started: Array<{ name: string; step: string }>;
}
async function run(flow: any, agents: any[], responder: (t: string) => any, o: Record<string, any> = {}) {
  const h: Harness = { events: [], started: [] };
  const r = await runFaux({
    flow, agents, responder, maxTurns: 48,
    onDecision: (e) => h.events.push(e),
    onAgentStarted: (name, step) => h.started.push({ name, step }),
    ...o,
  });
  return { r, ...h };
}
const judgeSays = (branches: Record<string, string>) => (t: string) => {
  for (const [marker, branch] of Object.entries(branches)) if (t.includes(marker)) return scriptFinish({ status: "complete", summary: "judged", branch });
  return scriptFinish({ status: "complete", summary: `worked: ${t.slice(0, 40)}` });
};

// Two sequential decision points; every branch leads to a distinct worker step.
const TWO_GATES = (header: string, gate2Decider = "") => `name: two-gates
description: two decision points
decision_agent: judge
${header}steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
  - id: gate1
    type: agent-decision
    task: "GATE1: is the build fine?"
    blockedBy: [build]
    branches:
      ok: { to: ship1, means: "build is fine" }
      bad: { to: fix1, means: "build is broken" }
  - id: ship1
    type: agent
    agent: worker
    task: "SHIP1"
  - id: fix1
    type: agent
    agent: worker
    task: "FIX1"
  - id: gate2
    type: agent-decision
    task: "GATE2: is the release fine?"
    blockedBy: [ship1, fix1]
${gate2Decider}    branches:
      ok: { to: ship2, means: "release is fine" }
      bad: { to: fix2, means: "release is broken" }
  - id: ship2
    type: agent
    agent: worker
    task: "SHIP2"
  - id: fix2
    type: agent
    agent: worker
    task: "FIX2"
`;

describe("e2e faux: decider chain resolution across two decision points", () => {
  it("step decider overrides flow decider, which overrides settings `decider`", async () => {
    const { flow, agents } = author(TWO_GATES("decider: [flow/model, agent]\n", "    decider: [step/model]\n"));
    const calls: string[] = [];
    const rec = (name: string, label: string): ClassifierEntry => async (q) => { calls.push(`${name}@${q.question.instructions.slice(0, 5)}`); return { ok: true, answer: { label, confidence: 0.95 } } as EntryResult; };
    const { r, events, started } = await run(flow, agents, judgeSays({}), {
      decider: { entries: ["settings/model", "agent"] },
      entryOverrides: { "settings/model": rec("settings", "bad"), "flow/model": rec("flow", "ok"), "step/model": rec("step", "bad") },
    });
    expect(r.status).not.toBe("error");
    // gate1 has no decider → flow chain (not settings); gate2 → its own chain.
    expect(calls).toEqual(["flow@GATE1", "step@GATE2"]);
    expect(events.map((e) => [e.stepId, e.chain, e.routedBy, e.label])).toEqual([
      ["gate1", ["flow/model", "agent"], "flow/model", "ok"],
      ["gate2", ["step/model"], "step/model", "bad"],
    ]);
    expect(ran(r, "ship1")).toBe(true);
    expect(skipped(r, "fix1")).toBe(true);
    expect(ran(r, "fix2")).toBe(true);
    expect(skipped(r, "ship2")).toBe(true);
    // No decision agent was needed at either point.
    expect(started.some((s) => s.name === "judge")).toBe(false);
  });

  it("the `flows.decider` setting applies when neither flow nor step declare a chain", async () => {
    const { flow, agents } = author(TWO_GATES("", "    decider: [agent]\n"));
    const calls: string[] = [];
    const rec = (label: string): ClassifierEntry => async (q) => { calls.push(q.question.instructions.slice(0, 5)); return { ok: true, answer: { label, confidence: 0.9 } } as EntryResult; };
    const { r, events, started } = await run(flow, agents, judgeSays({ GATE2: "ok" }), {
      decider: { entries: ["settings/model", "agent"] },
      entryOverrides: { "settings/model": rec("ok") },
    });
    expect(r.status).not.toBe("error");
    expect(calls).toEqual(["GATE1"]); // gate2 overrides with [agent] → settings classifier not consulted
    expect(events[0]).toMatchObject({ stepId: "gate1", chain: ["settings/model", "agent"], routedBy: "settings/model", label: "ok" });
    expect(events[1]).toMatchObject({ stepId: "gate2", chain: ["agent"], routedBy: "agent", label: "ok" });
    expect(started.filter((s) => s.name === "judge").map((s) => s.step)).toEqual(["gate2"]);
  });
});

// One decision point: build → gate → (ship | fix) [+ recover via on_error].
const ONE_GATE = (header: string, gateExtra = "", tail = "") => `name: one-gate
description: one decision point
decision_agent: judge
${header}steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
  - id: gate
    type: agent-decision
    task: "GATE: is the build fine?"
    blockedBy: [build]
${gateExtra}    branches:
      ok: { to: ship, means: "build is fine" }
      bad: { to: fix, means: "build is broken" }
  - id: ship
    type: agent
    agent: worker
    task: "SHIP"
  - id: fix
    type: agent
    agent: worker
    task: "FIX"
${tail}`;

describe("e2e faux: chain [system-one, typesafe/jev-latest, agent]", () => {
  it("records three attempts with their outcomes and lets the agent decide", async () => {
    const { flow, agents } = author(ONE_GATE("decider: [system-one, typesafe/jev-latest, agent]\n"));
    const { r, events, started } = await run(flow, agents, judgeSays({ "GATE:": "bad" }), {
      entryOverrides: {
        "system-one": failing("no-backend", "System One: no-backend"),
        "typesafe/jev-latest": cls("maybe", 0.99),
      },
    });
    expect(r.status).not.toBe("error");
    expect(ran(r, "fix")).toBe(true);
    expect(skipped(r, "ship")).toBe(true);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({ stepId: "gate", nodeKind: "agent-decision", consumerId: "pi-flows:one-gate:gate", chain: ["system-one", "typesafe/jev-latest", "agent"], routedBy: "agent", label: "bad" });
    expect(e.attempts.map((a) => [a.entry, a.outcome])).toEqual([
      ["system-one", "no-backend"],
      ["typesafe/jev-latest", "invalid-label"],
      ["agent", "ok"],
    ]);
    expect(e.attempts[0].reason).toContain("no-backend");
    expect(e.attempts[1]).toMatchObject({ label: "maybe", confidence: 0.99 });
    expect(e.attempts[1].reason).toContain("maybe");
    expect(e.attempts[1].reason).toContain("ok, bad");
    expect(e.attempts[2]).toMatchObject({ label: "bad", trusted: true });
    expect(started.filter((s) => s.step === "gate").map((s) => s.name)).toEqual(["judge"]);
  });
});

describe("e2e faux: trust policies", () => {
  it("`trust: confidence` + min_confidence 0.9 rejects 0.85 (and accepts 0.95)", async () => {
    const hdr = "decider: { chain: [typesafe/jev-latest, agent], trust: confidence, min_confidence: 0.9 }\n";
    const { flow, agents } = author(ONE_GATE(hdr));
    const low = await run(flow, agents, judgeSays({ "GATE:": "bad" }), { entryOverrides: { "typesafe/jev-latest": cls("ok", 0.85) } });
    expect(low.events[0].routedBy).toBe("agent");
    expect(low.events[0].attempts[0]).toMatchObject({ entry: "typesafe/jev-latest", outcome: "untrusted", trusted: false, confidence: 0.85, agreed: false });
    expect(ran(low.r, "fix")).toBe(true);
    expect(skipped(low.r, "ship")).toBe(true);

    const high = await run(flow, agents, judgeSays({ "GATE:": "bad" }), { entryOverrides: { "typesafe/jev-latest": cls("ok", 0.95) } });
    expect(high.events[0]).toMatchObject({ routedBy: "typesafe/jev-latest", label: "ok" });
    expect(high.started.some((s) => s.name === "judge")).toBe(false);
    expect(ran(high.r, "ship")).toBe(true);
  });

  it("trust and min_confidence resolve field by field: a step overrides only min_confidence", async () => {
    const hdr = "decider: { chain: [typesafe/jev-latest, agent], trust: confidence, min_confidence: 0.9 }\n";
    const { flow, agents } = author(ONE_GATE(hdr, "    decider: { min_confidence: 0.8 }\n"));
    const { events, started, r } = await run(flow, agents, judgeSays({ "GATE:": "bad" }), { entryOverrides: { "typesafe/jev-latest": cls("ok", 0.85) } });
    expect(events[0]).toMatchObject({ chain: ["typesafe/jev-latest", "agent"], routedBy: "typesafe/jev-latest", label: "ok" });
    expect(started.some((s) => s.name === "judge")).toBe(false);
    expect(ran(r, "ship")).toBe(true);
  });

  it("`trust: calibrated` routes System One answers only in enforce mode", async () => {
    const { flow, agents } = author(ONE_GATE("decider: { chain: [system-one, agent], trust: calibrated }\n"));
    // Even a 0.99-confidence answer is shadow when the mode is not `enforce`.
    const shadow = await run(flow, agents, judgeSays({ "GATE:": "ok" }), {
      entryOverrides: { "system-one": cls("ok", 0.99, undefined, { mode: "shadow", calibrated: true }) },
    });
    expect(shadow.events[0].routedBy).toBe("agent");
    expect(shadow.events[0].attempts[0]).toMatchObject({ entry: "system-one", outcome: "untrusted", trusted: false, mode: "shadow" });

    // A low-confidence answer in enforce mode routes (confidence is not consulted).
    const enforce = await run(flow, agents, judgeSays({ "GATE:": "ok" }), {
      entryOverrides: { "system-one": cls("bad", 0.2, undefined, { mode: "enforce", calibrated: true }) },
    });
    expect(enforce.events[0]).toMatchObject({ routedBy: "system-one", label: "bad" });
    expect(enforce.events[0].attempts[0]).toMatchObject({ outcome: "ok", trusted: true, mode: "enforce" });
    expect(enforce.started.some((s) => s.name === "judge")).toBe(false);
    expect(ran(enforce.r, "fix")).toBe(true);

    // An answer without a mode (pi-ai style) is never trusted under `calibrated`.
    const noMode = await run(flow, agents, judgeSays({ "GATE:": "ok" }), { entryOverrides: { "system-one": cls("bad", 0.99) } });
    expect(noMode.events[0].routedBy).toBe("agent");
  });

  it("`trust: auto` (default): calibrated System One in shadow does not route; uncalibrated at 0.9 does", async () => {
    const { flow, agents } = author(ONE_GATE("decider: [system-one, agent]\n"));
    const calibratedShadow = await run(flow, agents, judgeSays({ "GATE:": "bad" }), {
      entryOverrides: { "system-one": cls("ok", 0.99, undefined, { mode: "shadow", calibrated: true }) },
    });
    expect(calibratedShadow.events[0]).toMatchObject({ routedBy: "agent", label: "bad" });
    expect(calibratedShadow.events[0].attempts[0]).toMatchObject({ outcome: "untrusted", trusted: false, agreed: false });

    const uncalibrated = await run(flow, agents, judgeSays({ "GATE:": "bad" }), {
      entryOverrides: { "system-one": cls("ok", 0.9, undefined, { mode: "shadow", calibrated: false }) },
    });
    expect(uncalibrated.events[0]).toMatchObject({ routedBy: "system-one", label: "ok" });
    expect(uncalibrated.started.some((s) => s.name === "judge")).toBe(false);
    expect(ran(uncalibrated.r, "ship")).toBe(true);
  });

  it("shadow answers carry `agreed` relative to the routed label", async () => {
    const { flow, agents } = author(ONE_GATE("decider: { chain: [system-one, typesafe/jev-latest, agent], trust: calibrated }\n"));
    const shadow = (label: string) => cls(label, 0.9, undefined, { mode: "shadow", calibrated: true });
    // The agent says "bad": the first shadow said "ok" (disagrees), the second "bad" (agrees).
    const { events, r } = await run(flow, agents, judgeSays({ "GATE:": "bad" }), {
      entryOverrides: { "system-one": shadow("ok"), "typesafe/jev-latest": shadow("bad") },
    });
    const e = events[0];
    expect(e.routedBy).toBe("agent");
    expect(e.attempts.map((a) => [a.entry, a.outcome, a.agreed])).toEqual([
      ["system-one", "untrusted", false],
      ["typesafe/jev-latest", "untrusted", true],
      ["agent", "ok", undefined],
    ]);
    expect(ran(r, "fix")).toBe(true);
  });
});

describe("e2e faux: exhausted classifier-only chain", () => {
  const TAIL = `  - id: recover
    type: agent
    agent: worker
    task: "RECOVER"
`;
  const jev = failing("error", "backend exploded");

  it("fails the step softly and routes to the on_error step", async () => {
    const { flow, agents } = author(ONE_GATE("decider: [typesafe/jev-latest]\n", "    on_error: recover\n", TAIL));
    const { r, events, started } = await run(flow, agents, judgeSays({}), { entryOverrides: { "typesafe/jev-latest": jev } });
    expect(ran(r, "recover")).toBe(true);
    expect(skipped(r, "ship")).toBe(true);
    expect(skipped(r, "fix")).toBe(true);
    expect(r.status).not.toBe("aborted");
    expect(events).toHaveLength(1);
    expect(events[0].routedBy).toBeUndefined();
    expect(events[0].label).toBeUndefined();
    expect(events[0].attempts).toMatchObject([{ entry: "typesafe/jev-latest", outcome: "error", reason: "backend exploded" }]);
    // No agent is in the chain, so no agent session ran for the gate.
    expect(started.some((s) => s.name === "judge")).toBe(false);
    // The failed gate result carries the attempt list.
    expect(r.results.gate.status).toBe("error");
    expect(r.results.gate.summary).toContain("backend exploded");
  });

  it("without on_error the flow halts and the attempts are in the error", async () => {
    const { flow, agents } = author(ONE_GATE("decider: [typesafe/jev-latest]\n", "", TAIL));
    const { r } = await run(flow, agents, judgeSays({}), { entryOverrides: { "typesafe/jev-latest": jev } });
    expect(r.status).toBe("error");
    for (const id of ["ship", "fix", "recover"]) expect(ran(r, id)).toBe(false);
    const msg = r.lastResult.result.summary;
    expect(msg).toContain("typesafe/jev-latest");
    expect(msg).toContain("backend exploded");
    expect(msg).toContain("ok, bad"); // valid labels
  });
});

describe("e2e faux: means + state reach the classifier, never the event", () => {
  const LONG = `REVIEW-DETAIL-${"x".repeat(400)}`;
  const YAML = `name: state-flow
description: classifier sees only declared state
decision_agent: judge
decider: [typesafe/jev-latest, agent]
steps:
  - id: review
    type: agent
    agent: reviewer
    task: "REVIEW the change"
    outputs:
      - name: verdict
  - id: gate
    type: agent-decision
    task: "Decide for \${{task}}: is the review clean?"
    blockedBy: [review]
    state:
      review: "\${{result.review.summary}}"
      verdict: "\${{result.review.verdict}}"
    branches:
      done: { to: report, means: "No blocking issues remain" }
      fix: { to: fixer, means: "A blocking issue was found" }
  - id: report
    type: agent
    agent: worker
    task: "REPORT"
  - id: fixer
    type: agent
    agent: worker
    task: "FIXER"
`;
  const reviewer = `---\nname: reviewer\ndescription: r\nmodel: faux/faux-1\ntools: read\noutputs:\n  - name: verdict\n---\n\nYou review.\n`;
  const mds = [agentMd("worker"), agentMd("judge"), reviewer];

  it("passes the exact question and the declared state; the event has no state, task or output text", async () => {
    const { flow, agents } = author(YAML, mds);
    const seen: Asked[] = [];
    const responder = (t: string) =>
      t.includes("REVIEW the change")
        ? scriptFinish({ status: "complete", summary: LONG, verdict: "pass-with-nits" })
        : scriptFinish({ status: "complete", summary: "w" });
    const { r, events } = await run(flow, agents, responder, { entryOverrides: { "typesafe/jev-latest": cls("done", 0.95, seen) } });
    expect(ran(r, "report")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      state: { review: LONG, verdict: "pass-with-nits" },
      question: {
        type: "choice",
        instructions: "Decide for flow task: is the review clean?",
        criteria: { done: "No blocking issues remain", fix: "A blocking issue was found" },
      },
    });
    // flow:decision never carries state, task text or agent output
    const text = JSON.stringify(events);
    for (const secret of ["REVIEW-DETAIL", "pass-with-nits", "flow task", "is the review clean", "No blocking issues"]) {
      expect(text).not.toContain(secret);
    }
    expect(events[0]).toMatchObject({ routedBy: "typesafe/jev-latest", label: "done" });
  });

  it("without `state:` the classifier sees `{ task }` only; a failing decision agent's output stays out of the event", async () => {
    const noState = YAML.replace(/ {4}state:\n {6}review:.*\n {6}verdict:.*\n/, "");
    const { flow, agents } = author(noState, mds);
    const seen: Asked[] = [];
    // The classifier is unsure; the decision agent then finishes WITHOUT a branch, with a long summary.
    const responder = (t: string) =>
      t.includes("REVIEW the change")
        ? scriptFinish({ status: "complete", summary: "fine", verdict: "ok" })
        : scriptFinish({ status: "complete", summary: `AGENT-SECRET-${"y".repeat(500)}` });
    const agentTasks: string[] = [];
    const { r, events } = await run(flow, agents, (t: string) => { if (t.includes("is the review clean")) agentTasks.push(t); return responder(t); }, { entryOverrides: { "typesafe/jev-latest": cls("done", 0.3, seen) } });
    expect(seen[0].state).toEqual({ task: "Decide for flow task: is the review clean?" });
    // The decision agent sees the task plus each branch's `means`; with no `state:` there is no State section.
    expect(agentTasks.length).toBeGreaterThanOrEqual(1);
    expect(agentTasks[0]).toContain("Decide for flow task: is the review clean?\n\nBranches (call finish with exactly one of these as `branch`):\n- done: No blocking issues remain\n- fix: A blocking issue was found");
    expect(agentTasks[0]).not.toContain("State:");
    expect(r.status).toBe("error"); // exhausted: no silent first-branch default
    expect(ran(r, "report")).toBe(false);
    expect(ran(r, "fixer")).toBe(false);
    expect(events[0].routedBy).toBeUndefined();
    const text = JSON.stringify(events);
    expect(text).not.toContain("AGENT-SECRET");
    expect(text).not.toContain("flow task");
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["typesafe/jev-latest", "untrusted"], ["agent", "invalid-label"]]);
  });
});

describe("e2e faux: the decision agent sees what the classifier saw", () => {
  const YAML = `name: agent-sees
description: classifier unsure, agent decides with state + means
decision_agent: judge
decider: [typesafe/jev-latest, agent]
steps:
  - id: review
    type: agent
    agent: reviewer
    task: "REVIEW the change"
    outputs:
      - name: verdict
  - id: gate
    type: agent-decision
    task: "GATE for \${{task}}: is the review clean?"
    blockedBy: [review]
    state:
      review: "\${{result.review.summary}}"
      verdict: "\${{result.review.verdict}}"
    branches:
      done: { to: report, means: "No blocking issues remain" }
      fix: { to: fixer, means: "A blocking issue was found" }
    on_error: recover
  - id: report
    type: agent
    agent: worker
    task: "REPORT"
  - id: fixer
    type: agent
    agent: worker
    task: "FIXER"
  - id: recover
    type: agent
    agent: worker
    task: "RECOVER"
`;
  const reviewer = `---\nname: reviewer\ndescription: r\nmodel: faux/faux-1\ntools: read\noutputs:\n  - name: verdict\n---\n\nYou review.\n`;
  const mds = [agentMd("worker"), agentMd("judge"), reviewer];
  const respond = (judge: () => any, gateTasks: string[]) => (t: string) => {
    if (t.includes("REVIEW the change")) return scriptFinish({ status: "complete", summary: "REVIEW-TEXT-77 one nit", verdict: "pass-with-nits" });
    if (t.includes("GATE for")) { gateTasks.push(t); return judge(); }
    return scriptFinish({ status: "complete", summary: "worked" });
  };

  it("after an untrusted classifier answer, the agent's task carries the expanded state and every branch's means", async () => {
    const { flow, agents } = author(YAML, mds);
    const seen: Asked[] = [];
    const gateTasks: string[] = [];
    const { r, events } = await run(flow, agents, respond(() => scriptFinish({ status: "complete", summary: "j", branch: "fix" }), gateTasks), {
      entryOverrides: { "typesafe/jev-latest": cls("done", 0.2, seen) },
    });
    expect(ran(r, "fixer")).toBe(true);
    expect(skipped(r, "report")).toBe(true);
    expect(gateTasks).toHaveLength(1);
    expect(gateTasks[0]).toContain(
      "GATE for flow task: is the review clean?\n\nBranches (call finish with exactly one of these as `branch`):\n" +
      "- done: No blocking issues remain\n- fix: A blocking issue was found\n\n" +
      "State:\n- review: REVIEW-TEXT-77 one nit\n- verdict: pass-with-nits",
    );
    // classifier and agent saw the same state
    expect(seen[0].state).toEqual({ review: "REVIEW-TEXT-77 one nit", verdict: "pass-with-nits" });
    expect(events[0]).toMatchObject({ routedBy: "agent", label: "fix" });
    expect(JSON.stringify(events)).not.toContain("REVIEW-TEXT-77");
  });

  it("an agent that finishes \"blocked\" after an untrusted classifier is a failed attempt; on_error routes", async () => {
    const { flow, agents } = author(YAML, mds);
    const gateTasks: string[] = [];
    const { r, events, started } = await run(flow, agents, respond(() => scriptFinish({ status: "blocked", summary: "need more info", branch: "done" }), gateTasks), {
      entryOverrides: { "typesafe/jev-latest": cls("done", 0.2) },
    });
    expect(ran(r, "recover")).toBe(true);
    expect(skipped(r, "report")).toBe(true);
    expect(skipped(r, "fixer")).toBe(true);
    expect(started.filter((s) => s.step === "gate").map((s) => s.name)).toContain("judge");
    expect(events).toHaveLength(1);
    expect(events[0].routedBy).toBeUndefined();
    expect(events[0].label).toBeUndefined();
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["typesafe/jev-latest", "untrusted"], ["agent", "invalid-label"]]);
    expect(events[0].attempts[1].reason).toBe("the decision agent finished with status blocked");
    expect(r.results.gate.status).toBe("error");
    expect(r.results.gate.summary).toContain("the decision agent finished with status blocked");
  });
});

describe("e2e faux: forks decided by a classifier", () => {
  const FORK = (extra = "") => `name: fork-flow
description: fork with a decider chain
decision_agent: judge
steps:
  - id: fk
    type: fork
    question: "Ship it?"
    options: [ship, hold]
    branches:
      ship: finish
      hold: fixer
    allowCustom: true
${extra}  - id: fixer
    type: agent
    agent: worker
    task: "FIXER"
  - id: finish
    type: agent
    agent: worker
    task: "FINISH"
`;

  it("autonomous fork: the classifier decides (criteria = options), no prompt, no agent", async () => {
    const { flow, agents } = author(FORK("    decider: [system-one, agent]\n"));
    const seen: Asked[] = [];
    let asked = 0;
    const { r, events, started } = await run(flow, agents, judgeSays({}), {
      isAutonomous: () => true,
      askUser: async () => { asked++; return { answer: "ship" }; },
      entryOverrides: { "system-one": cls("hold", 0.9, seen) },
    });
    expect(asked).toBe(0);
    expect(ran(r, "fixer")).toBe(true);
    expect(skipped(r, "finish")).toBe(true);
    expect(seen[0].question.criteria).toEqual({ ship: "ship", hold: "hold" });
    expect(seen[0].question.type).toBe("choice");
    expect(seen[0].question.instructions).toBe("Ship it?"); // fork without `task:` → its question
    expect(seen[0].state).toEqual({ task: "Ship it?" });
    expect(events[0]).toMatchObject({ stepId: "fk", nodeKind: "fork", routedBy: "system-one", label: "hold" });
    expect(started.some((s) => s.name === "judge")).toBe(false);
  });

  it("interactive fork: 'Other' free text is mapped by a classifier (state = question + userText)", async () => {
    const { flow, agents } = author(FORK("    decider: [typesafe/jev-latest, agent]\n"));
    const seen: Asked[] = [];
    const prompts: Array<{ q: string; options?: string[] }> = [];
    const { r, events } = await run(flow, agents, judgeSays({}), {
      entryOverrides: { "typesafe/jev-latest": cls("ship", 0.9, seen) },
      askUser: async (q: string, _t: string, options?: string[]) => { prompts.push({ q, options }); return { answer: "__custom_decide__", notes: "ship it anyway" }; },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].options).toEqual(["ship", "hold"]);
    expect(ran(r, "finish")).toBe(true);
    expect(skipped(r, "fixer")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toMatchObject({ question: "Ship it?", userText: "ship it anyway" });
    expect(seen[0].question.criteria).toEqual({ ship: "ship", hold: "hold" });
    expect(events[0]).toMatchObject({ stepId: "fk", routedBy: "typesafe/jev-latest", label: "ship" });
    // the typed text itself stays out of the event
    expect(JSON.stringify(events)).not.toContain("ship it anyway");
  });

  it("interactive 'Other' with an exhausted chain asks the user again (never a silent default)", async () => {
    const { flow, agents } = author(FORK("    decider: [system-one, agent]\n"));
    const prompts: string[] = [];
    const answers = [{ answer: "__custom_decide__", notes: "dunno, whatever" }, { answer: "hold" }];
    // The decision agent never names a branch (plain text); workers finish normally.
    const noBranch = (t: string) => (/FIXER|FINISH/.test(t) ? scriptFinish({ status: "complete", summary: "worked" }) : fauxAssistantMessage([fauxText("no opinion")]));
    const { r, events } = await run(flow, agents, noBranch, {
      entryOverrides: { "system-one": failing("no-backend", "System One: no-backend") },
      askUser: async (q: string) => { prompts.push(q); return answers.shift() ?? { answer: "hold" }; },
    });
    expect(prompts).toEqual(["Ship it?", "Ship it?"]);
    // the user's second (direct) choice is what routed
    expect(ran(r, "fixer")).toBe(true);
    expect(skipped(r, "finish")).toBe(true);
    expect(r.forks.fk.answer).toBe("hold");
    expect(events).toHaveLength(1);
    expect(events[0].routedBy).toBeUndefined();
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["system-one", "no-backend"], ["agent", "invalid-label"]]);
  });
});

describe("e2e faux: abort during a slow classifier", () => {
  it("cancels the in-flight call, tries no later entry, and stops the flow", async () => {
    const { flow, agents } = author(ONE_GATE("decider: [slow/model, next/model, agent]\n"));
    const ac = new AbortController();
    const tried: string[] = [];
    let sawAbort = false;
    const slow: ClassifierEntry = (_q, signal) => new Promise<EntryResult>((resolve) => {
      tried.push("slow/model");
      const timer = setTimeout(() => resolve({ ok: true, answer: { label: "ok", confidence: 0.99 } }), 10_000);
      signal.addEventListener("abort", () => { sawAbort = true; clearTimeout(timer); resolve({ ok: false, outcome: "aborted" }); });
      setTimeout(() => ac.abort(), 30);
    });
    const next: ClassifierEntry = async () => { tried.push("next/model"); return { ok: true, answer: { label: "ok", confidence: 0.99 } } as EntryResult; };
    const t0 = Date.now();
    const { r, events, started } = await run(flow, agents, judgeSays({ "GATE:": "ok" }), {
      signal: ac.signal,
      entryOverrides: { "slow/model": slow, "next/model": next },
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(sawAbort).toBe(true);
    expect(tried).toEqual(["slow/model"]);
    expect(r.status).toBe("aborted");
    expect(started.some((s) => s.name === "judge")).toBe(false);
    for (const id of ["ship", "fix"]) expect(ran(r, id)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["slow/model", "aborted"]]);
    expect(events[0].routedBy).toBeUndefined();
  });
});

describe("e2e faux: looping review gate where the classifier becomes confident", () => {
  const LOOP = `name: gate-loop
description: implement, review, gate; loop until the classifier is confident it is clean
decision_agent: judge
decider: [typesafe/jev-latest, agent]
steps:
  - id: implement
    type: agent
    agent: worker
    task: "IMPLEMENT attempt \${{loop.gate.iteration}}"
  - id: review
    type: agent
    agent: reviewer
    task: "REVIEW"
    blockedBy: [implement]
  - id: gate
    type: agent-decision
    task: "Is the review clean?"
    blockedBy: [review]
    state:
      review: "\${{result.review.summary}}"
      pass: "\${{loop.gate.iteration}}"
    branches:
      done: { to: report, means: "No blocking issues remain" }
      fix: { to: implement, means: "A blocking issue was found" }
    max_iterations: 4
  - id: report
    type: agent
    agent: worker
    task: "REPORT"
`;

  it("iteration 1 is shadow (agent decides 'fix'); iteration 2 routes 'done' without the agent", async () => {
    const { flow, agents } = author(LOOP);
    let reviews = 0;
    const implementTasks: string[] = [];
    const judgeTasks: string[] = [];
    const responder = (t: string) => {
      if (t.includes("IMPLEMENT")) { implementTasks.push(t); return scriptFinish({ status: "complete", summary: "implemented" }); }
      if (t.includes("REVIEW")) return scriptFinish({ status: "complete", summary: ++reviews === 1 ? "BLOCKER: no test" : "clean" });
      if (t.includes("REPORT")) return scriptFinish({ status: "complete", summary: "reported" });
      judgeTasks.push(t);
      return scriptFinish({ status: "complete", summary: "judged", branch: "fix" });
    };
    const seen: Asked[] = [];
    let call = 0;
    const jev: ClassifierEntry = async (q) => {
      seen.push(q);
      return { ok: true, answer: ++call === 1 ? { label: "done", confidence: 0.4 } : { label: "done", confidence: 0.93 } } as EntryResult;
    };
    const { r, events, started } = await run(flow, agents, responder, { entryOverrides: { "typesafe/jev-latest": jev } });

    expect(r.status).not.toBe("error");
    expect(ran(r, "report")).toBe(true);
    const spawns = (step: string) => started.filter((s) => s.step === step).length;
    expect(spawns("implement")).toBe(2);
    expect(spawns("review")).toBe(2);
    expect(spawns("report")).toBe(1);
    // gate cards: the judge spawned once (pass 1); pass 2 was answered by the classifier alone.
    expect(started.filter((s) => s.step === "gate").map((s) => s.name)).toEqual(["judge", "typesafe/jev-latest"]);
    expect(call).toBe(2);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ routedBy: "agent", label: "fix" });
    expect(events[0].attempts[0]).toMatchObject({ outcome: "untrusted", trusted: false, label: "done", agreed: false });
    expect(events[1]).toMatchObject({ routedBy: "typesafe/jev-latest", label: "done" });
    expect(events[1].attempts).toHaveLength(1);

    // The classifier saw each pass's own review.
    expect(seen.map((q) => q.state.review)).toEqual(["BLOCKER: no test", "clean"]);
    // Loop counter (docs/flows.md "Loop iteration is 1-based"): pass N observes N, and on every
    // pass the body and the decision step observe the same value, never beyond max_iterations.
    const bodyIter = implementTasks.map((t) => Number(/attempt (\d+)/.exec(t)?.[1]));
    expect(bodyIter).toEqual([1, 2]); // pass N observes N
    expect(seen.map((q) => Number(q.state.pass))).toEqual(bodyIter);
    for (const n of bodyIter) expect(n).toBeLessThanOrEqual(4);
    expect(r.results.gate.summary).toMatch(/done/);
    // The judge (pass 1 only) saw this pass's state and the branch means.
    expect(judgeTasks).toHaveLength(1);
    expect(judgeTasks[0]).toContain("Is the review clean?\n\nBranches (call finish with exactly one of these as `branch`):\n- done: No blocking issues remain\n- fix: A blocking issue was found");
    expect(judgeTasks[0]).toContain("State:\n- review: BLOCKER: no test\n- pass: 1");
  });
});
