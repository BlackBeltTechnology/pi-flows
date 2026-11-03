/** Spec: classifier-decisions — engine wiring through real runFlow (5.1, 6.1). */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import type { DecisionEvent, FlowConfig } from "../extensions/flow-engine/types.js";
import type { ClassifierEntry, EntryResult } from "../extensions/flow-engine/decider/types.js";

const agents = ["worker", "flow-decision"].map((name) => makeAgent({ name, model: "@fast", modelRefs: ["@fast"] }));

function adFlow(extra: Partial<FlowConfig> = {}, stepExtra: Record<string, unknown> = {}): FlowConfig {
  return {
    name: "ship", description: "d", source: "<t>", ...extra,
    steps: [
      { stepType: "agent-decision", id: "gate", task: "Is it done? ${{task}}", branches: { done: "finish", fix: "fixer" }, branchMeans: { done: "ok", fix: "bad" }, ...stepExtra } as any,
      { stepType: "agent", id: "fixer", agent: "worker", task: "FIX" },
      { stepType: "agent", id: "finish", agent: "worker", task: "FINISH" },
    ],
  };
}
const forkFlow = (stepExtra: Record<string, unknown> = {}, extra: Partial<FlowConfig> = {}): FlowConfig => ({
  name: "ship", description: "d", source: "<t>", ...extra,
  steps: [
    { stepType: "fork", id: "fk", question: "Ship?", options: ["yes", "no"], branches: { yes: "finish", no: "fixer" }, allowCustom: true, agent: "flow-decision", ...stepExtra } as any,
    { stepType: "agent", id: "fixer", agent: "worker", task: "FIX" },
    { stepType: "agent", id: "finish", agent: "worker", task: "FINISH" },
  ],
});

const agentSays = (branch?: string) => (t: string) =>
  t.includes("Task: FIX") || t.includes("Task: FINISH")
    ? scriptFinish({ status: "complete", summary: t })
    : branch
      ? scriptFinish({ status: "complete", summary: "decided", branch })
      : fauxAssistantMessage([fauxText("no idea")]);

const cls = (label: string, confidence: number, calls?: string[]): ClassifierEntry => async (q) => {
  calls?.push(JSON.stringify(q));
  return { ok: true, answer: { label, confidence } } as EntryResult;
};

const ran = (r: any, id: string) => r.results[id]?.status === "complete";

async function run(flow: FlowConfig, o: any = {}) {
  const events: DecisionEvent[] = [];
  const started: Array<[string, string]> = [];
  const r = await runFaux({
    flow, agents, responder: agentSays(o.branch), onDecision: (e) => events.push(e),
    onAgentStarted: (n, s) => started.push([n, s]), ...o,
  });
  return { r, events, started };
}

describe("decider wiring: agent-decision", () => {
  it("default chain is [agent], unchanged", async () => {
    const { r, events, started } = await run(adFlow(), { branch: "done" });
    expect(ran(r, "finish")).toBe(true);
    expect(ran(r, "fixer")).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stepId: "gate", routedBy: "agent", label: "done", consumerId: "pi-flows:ship:gate", chain: ["agent"] });
    expect(started.filter(([, s]) => s === "gate").map(([n]) => n)).toEqual(["flow-decision"]);
  });

  it("trusted classifier routes without spawning the decision agent", async () => {
    const calls: string[] = [];
    const { r, events, started } = await run(adFlow({}, { decider: { entries: ["typesafe/jev-latest", "agent"] } }), {
      entryOverrides: { "typesafe/jev-latest": cls("fix", 0.95, calls) },
    });
    expect(ran(r, "fixer")).toBe(true);
    expect(ran(r, "finish")).toBe(false);
    expect(started.some(([n]) => n === "flow-decision")).toBe(false);
    expect(events[0]).toMatchObject({ routedBy: "typesafe/jev-latest", label: "fix" });
    // question mapped from means; default state {task}
    const q = JSON.parse(calls[0]);
    expect(q.question.criteria).toEqual({ done: "ok", fix: "bad" });
    expect(q.state).toEqual({ task: "Is it done? flow task" });
    expect(r.results.gate.summary).toMatch(/fix/);
  });

  it("flows.decider applies to steps without one; step decider overrides", async () => {
    const calls: string[] = [];
    const over = { "system-one": cls("fix", 0.9, calls) };
    await run(adFlow(), { decider: { entries: ["system-one", "agent"] }, entryOverrides: over, branch: "done" });
    expect(calls).toHaveLength(1);
    calls.length = 0;
    await run(adFlow({}, { decider: { entries: ["agent"] } }), { decider: { entries: ["system-one", "agent"] }, entryOverrides: over, branch: "done" });
    expect(calls).toHaveLength(0);
  });

  it("low confidence → shadow, agent decides; agreed recorded; no state/task in event", async () => {
    const { r, events } = await run(adFlow({}, { decider: { entries: ["typesafe/jev-latest", "agent"], trust: "confidence" } }), {
      entryOverrides: { "typesafe/jev-latest": cls("done", 0.6) }, branch: "done",
    });
    expect(ran(r, "finish")).toBe(true);
    const e = events[0];
    expect(e.routedBy).toBe("agent");
    expect(e.attempts[0]).toMatchObject({ entry: "typesafe/jev-latest", outcome: "untrusted", trusted: false, agreed: true });
    const text = JSON.stringify(e);
    expect(text).not.toContain("Is it done");
    expect(text).not.toContain("flow task");
  });

  it("declared state is template-expanded", async () => {
    const calls: string[] = [];
    await run(adFlow({}, { decider: { entries: ["system-one"] }, state: { t: "T=${{task}}" } }), { entryOverrides: { "system-one": cls("done", 0.9, calls) } });
    expect(JSON.parse(calls[0]).state).toEqual({ t: "T=flow task" });
  });

  it("agent without a branch fails the step; no first-branch route", async () => {
    const { r, events } = await run(adFlow(), { branch: undefined });
    expect(ran(r, "finish")).toBe(false);
    expect(ran(r, "fixer")).toBe(false);
    expect(r.status).toBe("error");
    expect(events[0].routedBy).toBeUndefined();
  });

  it("invalid classifier label fails the step naming the label and valid labels", async () => {
    const { r } = await run(adFlow({}, { decider: { entries: ["system-one"] } }), { entryOverrides: { "system-one": cls("maybe", 0.99) } });
    expect(r.status).toBe("error");
    const msg = JSON.stringify(r.lastResult);
    expect(msg).toContain("maybe");
    expect(msg).toContain("done, fix");
  });
});

describe("decider wiring: fork", () => {
  it("autonomous fork: classifier routes", async () => {
    const { r, events } = await run(forkFlow({ decider: { entries: ["system-one"] } }), {
      isAutonomous: () => true, entryOverrides: { "system-one": cls("no", 0.9) },
    });
    expect(ran(r, "fixer")).toBe(true);
    expect(events[0]).toMatchObject({ stepId: "fk", routedBy: "system-one", label: "no" });
  });

  it("autonomous fork exhausted → step fails", async () => {
    const { r } = await run(forkFlow(), { isAutonomous: () => true, branch: undefined });
    expect(r.status).toBe("error");
    expect(ran(r, "finish")).toBe(false);
  });

  it("interactive 'Other' exhausted → user is asked again", async () => {
    const asked: string[] = [];
    const answers = ["__custom_decide__", "yes"];
    const { r } = await run(forkFlow({ decider: { entries: ["system-one"] } }), {
      entryOverrides: { "system-one": async () => ({ ok: false, outcome: "no-backend" }) as EntryResult },
      askUser: async (q: string) => { asked.push(q); const a = answers.shift() ?? "yes"; return { answer: a, notes: "ship it anyway" }; },
    });
    expect(asked.length).toBe(2);
    expect(ran(r, "finish")).toBe(true);
  });

  it("'Other' state carries question and userText", async () => {
    const calls: string[] = [];
    await run(forkFlow({ decider: { entries: ["system-one"] } }), {
      entryOverrides: { "system-one": cls("yes", 0.9, calls) },
      askUser: async () => ({ answer: "__custom_decide__", notes: "ship it anyway" }),
    });
    const q = JSON.parse(calls[0]);
    expect(q.state).toMatchObject({ question: "Ship?", userText: "ship it anyway" });
    expect(q.question.criteria).toEqual({ yes: "yes", no: "no" });
  });
});

describe("decider wiring: abort", () => {
  it("abort while a classifier is in flight stops the chain", async () => {
    const ac = new AbortController();
    const tried: string[] = [];
    const r = await runFaux({
      flow: adFlow({}, { decider: { entries: ["a/b", "c/d", "agent"] } }), agents, responder: agentSays("done"), signal: ac.signal,
      entryOverrides: {
        "a/b": async () => { tried.push("a/b"); ac.abort(); return { ok: false, outcome: "error" } as EntryResult; },
        "c/d": async () => { tried.push("c/d"); return { ok: false, outcome: "error" } as EntryResult; },
      },
    });
    expect(tried).toEqual(["a/b"]);
    expect(r.status).toBe("aborted");
  });
});
