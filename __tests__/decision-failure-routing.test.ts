/**
 * classifier-decisions gaps:
 *  (a) exhausted decider chain is a SOFT failure → `on_error` routes when declared;
 *      without `on_error` the flow halts with the attempts message.
 *  (b) the flow TUI shows a decision line (label, routing entry, confidence).
 *  (c) failed-agent attempt reasons are capped; agent output never leaks into flow:decision.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { TuiFlowObserver } from "../extensions/flow-engine/flow-tui.js";
import type { DecisionEvent, FlowConfig } from "../extensions/flow-engine/types.js";

const agents = ["worker", "flow-decision"].map((name) => makeAgent({ name, model: "@fast", modelRefs: ["@fast"] }));

const flowWith = (kind: "agent-decision" | "fork", stepExtra: Record<string, unknown> = {}): FlowConfig => ({
  name: "ship", description: "d", source: "<t>",
  steps: [
    kind === "agent-decision"
      ? { stepType: "agent-decision", id: "gate", task: "Is it done?", branches: { done: "finish", fix: "fixer" }, branchMeans: { done: "ok", fix: "bad" }, ...stepExtra } as any
      : { stepType: "fork", id: "gate", question: "Ship?", options: ["yes", "no"], branches: { yes: "finish", no: "fixer" }, agent: "flow-decision", ...stepExtra } as any,
    { stepType: "agent", id: "fixer", agent: "worker", task: "FIX" },
    { stepType: "agent", id: "finish", agent: "worker", task: "FINISH" },
    { stepType: "agent", id: "report", agent: "worker", task: "REPORT" },
  ],
});

// The decision agent never gives a branch (plain text, no finish call).
const noBranch = (t: string) =>
  /Task: (FIX|FINISH|REPORT)/.test(t) ? scriptFinish({ status: "complete", summary: t }) : fauxAssistantMessage([fauxText("no idea")]);
const ran = (r: any, id: string) => r.results[id]?.status === "complete";

describe("(a) exhausted chain is soft → on_error", () => {
  it("parser keeps on_error on agent-decision and fork steps", () => {
    const f = parseFlowYamlString(`name: f
description: d
steps:
  - id: gate
    type: agent-decision
    task: t
    on_error: report
    branches:
      a: x
      b: y
  - id: fk
    type: fork
    question: q
    options: [a, b]
    on_error: report
    branches:
      a: x
      b: y
  - id: report
    type: agent
    agent: w
`, "<t>");
    expect((f.steps[0] as any).on_error).toBe("report");
    expect((f.steps[1] as any).on_error).toBe("report");
  });

  it("agent-decision exhausted + on_error → routes to report", async () => {
    const r = await runFaux({ flow: flowWith("agent-decision", { on_error: "report" }), agents, responder: noBranch });
    expect(ran(r, "report")).toBe(true);
    expect(ran(r, "finish")).toBe(false);
    expect(ran(r, "fixer")).toBe(false);
    expect(r.status).toBe("success");
  });

  it("agent-decision exhausted without on_error → flow halts with the attempts message", async () => {
    const r = await runFaux({ flow: flowWith("agent-decision"), agents, responder: noBranch });
    expect(r.status).toBe("error");
    expect(ran(r, "report")).toBe(false);
    expect(JSON.stringify(r.lastResult)).toContain("no decider produced a trusted, valid label");
  });

  it("autonomous fork exhausted + on_error → routes to report", async () => {
    const r = await runFaux({ flow: flowWith("fork", { on_error: "report" }), agents, responder: noBranch, isAutonomous: () => true });
    expect(ran(r, "report")).toBe(true);
    expect(r.status).toBe("success");
  });

  it("autonomous fork exhausted without on_error → halts", async () => {
    const r = await runFaux({ flow: flowWith("fork"), agents, responder: noBranch, isAutonomous: () => true });
    expect(r.status).toBe("error");
  });

  it("interactive fork exhausted still re-asks (on_error does not intercept)", async () => {
    const asked: string[] = [];
    const answers = ["__auto_decide__", "yes"];
    const r = await runFaux({
      flow: flowWith("fork", { on_error: "report" }), agents, responder: noBranch,
      askUser: async (q: string) => { asked.push(q); return { answer: answers.shift() ?? "yes" }; },
    });
    expect(asked.length).toBe(2);
    expect(ran(r, "finish")).toBe(true);
    expect(ran(r, "report")).toBe(false);
  });
});

describe("(b) TUI decision line", () => {
  const observer = () => {
    const notes: Array<{ message: string; level?: string }> = [];
    const pi = { events: { emit: (ch: string, d: any) => { if (ch === "flow:notify") notes.push(d); } } } as any;
    const obs = new TuiFlowObserver({ pi, flowManager: {} as any, extractAgentConfigs: () => [], buildAgentDeps: () => new Map() });
    return { obs, notes };
  };
  const base = { flowName: "ship", stepId: "gate", nodeKind: "agent-decision" as const, consumerId: "c", chain: ["x"] };

  it("classifier: label, entry and confidence", () => {
    const { obs, notes } = observer();
    obs.onDecision({
      ...base, routedBy: "typesafe/jev-latest", label: "fix",
      attempts: [{ entry: "typesafe/jev-latest", outcome: "ok", label: "fix", confidence: 0.91, trusted: true, latencyMs: 3 }],
    } as DecisionEvent);
    expect(notes.map((n) => n.message)).toEqual(["decided fix via typesafe/jev-latest (0.91)"]);
  });

  it("agent: no confidence", () => {
    const { obs, notes } = observer();
    obs.onDecision({
      ...base, routedBy: "agent", label: "done",
      attempts: [{ entry: "agent", outcome: "ok", label: "done", confidence: 1, trusted: true, latencyMs: 3 }],
    } as DecisionEvent);
    expect(notes.map((n) => n.message)).toEqual(["decided done via agent"]);
  });

  it("no line when nothing was routed", () => {
    const { obs, notes } = observer();
    obs.onDecision({ ...base, attempts: [] } as DecisionEvent);
    expect(notes).toEqual([]);
  });
});

describe("(c) flow:decision reasons are capped and exclude agent output", () => {
  it("a long agent output never appears in the event; reasons ≤ 200 chars", async () => {
    const SECRET = "TOPSECRET-" + "x".repeat(600);
    const events: DecisionEvent[] = [];
    await runFaux({
      flow: flowWith("agent-decision", { on_error: "report" }), agents,
      responder: (t: string) => /Task: (FIX|FINISH|REPORT)/.test(t) ? scriptFinish({ status: "complete", summary: t }) : fauxAssistantMessage([fauxText(SECRET)]),
      onDecision: (e: DecisionEvent) => events.push(e),
    });
    const text = JSON.stringify(events);
    expect(text).not.toContain("TOPSECRET");
    for (const a of events[0].attempts) expect((a.reason ?? "").length).toBeLessThanOrEqual(200);
  });
});
