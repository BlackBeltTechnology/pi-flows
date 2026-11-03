/**
 * End-to-end faux scenario across the batch-b1 changes, authored the way a
 * user writes files (YAML flow + markdown agents), validated, then run on the
 * real runFlow with the faux provider:
 *
 *   implement → review → gate (classifier first, agent fallback) ─fix→ implement (loop)
 *                                                            └done→ report
 *
 * Covers: @role fallback to the session model (resolver-agnostic-model-refs),
 * flow-level decision_agent and an agent-decision without `agent:`, decider
 * chain with trust/shadow + branch `means` + `state:` (classifier-decisions),
 * the TUI decision line text, reserved-output refusal, and validation of the
 * authored files.
 */
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";
import type { ClassifierEntry, EntryResult } from "../extensions/flow-engine/decider/types.js";

const FLOW_YAML = `name: review-loop
description: implement, review, decide, loop until clean
decision_agent: judge
decider: [typesafe/jev-latest, agent]
steps:
  - id: implement
    type: agent
    agent: coder
    task: "IMPLEMENT \${{task}}"
  - id: review
    type: agent
    agent: reviewer
    task: "REVIEW"
    blockedBy: [implement]
  - id: gate
    type: agent-decision
    task: "Is the review clean?"
    state:
      review: "\${{result.review.summary}}"
    branches:
      done: { to: report, means: "No blocking issues remain" }
      fix: { to: implement, means: "A blocking issue was found" }
    max_iterations: 3
    on_error: report
  - id: report
    type: agent
    agent: coder
    task: "REPORT"
`;

const agentMd = (name: string, model: string | null, outputs = "") =>
  `---\nname: ${name}\ndescription: ${name} agent\n${model ? `model: ${model}\n` : ""}tools: read\n${outputs}---\n\nYou are ${name}.\n`;

const CODER = agentMd("coder", "@coding", "outputs:\n  - name: outcome\n");
const REVIEWER = agentMd("reviewer", "[@fast, faux/faux-1]");
const JUDGE = agentMd("judge", null); // no model: → session model

// The reviewer finds an issue on the first pass only.
let reviews = 0;
const responder = (t: string) => {
  if (t.includes("IMPLEMENT")) return scriptFinish({ status: "complete", summary: "implemented", outcome: "done" });
  if (t.includes("REVIEW")) return scriptFinish({ status: "complete", summary: ++reviews === 1 ? "BLOCKER: missing test" : "clean" });
  if (t.includes("REPORT")) return scriptFinish({ status: "complete", summary: "report written", outcome: "done" });
  // decision agent (judge): reads the gate task
  return scriptFinish({ status: "complete", summary: "judged", branch: "fix" });
};

describe("e2e faux: review loop with classifier-first decisions", () => {
  it("authored files validate", () => {
    const flowDiag = validateFlowContent(FLOW_YAML, () => new Map(
      [CODER, REVIEWER, JUDGE].map((m) => { const a = parseAgentString(m, "<t>"); return [a.name, a]; }),
    ), () => true);
    expect(flowDiag.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const md of [CODER, REVIEWER, JUDGE]) {
      expect(validateAgentContent(md).diagnostics.filter((d) => d.severity === "error"), md).toEqual([]);
    }
  });

  it("runs: shadow answer falls back to the judge, then a trusted answer exits the loop", async () => {
    reviews = 0;
    const flow = parseFlowYamlString(FLOW_YAML, "<e2e>");
    const agents = [CODER, REVIEWER, JUDGE].map((m) => parseAgentString(m, "<e2e>"));

    const questions: any[] = [];
    let call = 0;
    const jev: ClassifierEntry = async (q) => {
      questions.push(q);
      // 1st: unsure (0.6, shadow) → judge decides; 2nd: confident (0.95) → routes.
      return (++call === 1
        ? { ok: true, answer: { label: "fix", confidence: 0.6 } }
        : { ok: true, answer: { label: "done", confidence: 0.95 } }) as EntryResult;
    };

    const events: DecisionEvent[] = [];
    const started: Array<{ name: string; step: string; model: any; extra: any }> = [];
    const judgeTasks: string[] = [];
    const result = await runFaux({
      flow, agents, maxTurns: 48,
      responder: (t) => { if (t.includes("Is the review clean?")) judgeTasks.push(t); return responder(t); },
      entryOverrides: { "typesafe/jev-latest": jev },
      onDecision: (e) => events.push(e),
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });

    // Flow completes through the loop and the report.
    expect(result.status).not.toBe("error");
    expect(result.results.report?.status).toBe("complete");
    expect(started.filter((s) => s.step === "implement")).toHaveLength(2);
    expect(started.filter((s) => s.step === "review")).toHaveLength(2);

    // Decision 1: classifier untrusted (shadow) → flow-level decision_agent "judge" routed "fix".
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ stepId: "gate", routedBy: "agent", label: "fix" });
    expect(events[0].attempts[0]).toMatchObject({ entry: "typesafe/jev-latest", trusted: false, agreed: true });
    // gate cards: pass 1 the judge agent decided; pass 2 the classifier did (no second judge spawn).
    expect(started.filter((s) => s.step === "gate").map((s) => s.name)).toEqual(["judge", "typesafe/jev-latest"]);
    // Decision 2: trusted classifier routes "done" without spawning the judge again.
    expect(events[1]).toMatchObject({ stepId: "gate", routedBy: "typesafe/jev-latest", label: "done" });

    // The classifier saw the `means` criteria and the declared state, not raw agent output.
    expect(questions[0].question.criteria).toEqual({ done: "No blocking issues remain", fix: "A blocking issue was found" });
    expect(questions[0].state).toEqual({ review: "BLOCKER: missing test" });
    expect(questions[1].state).toEqual({ review: "clean" });
    for (const e of events) expect(JSON.stringify(e)).not.toContain("BLOCKER");
    // The judge (pass 1) saw the same inputs as the classifier: branch means and the expanded state.
    expect(judgeTasks).toHaveLength(1);
    expect(judgeTasks[0]).toContain(
      "Is the review clean?\n\nBranches (call finish with exactly one of these as `branch`):\n" +
      "- done: No blocking issues remain\n- fix: A blocking issue was found\n\nState:\n- review: BLOCKER: missing test",
    );

    // @coding / list / no model: all run on the session model without a resolver.
    const coder = started.find((s) => s.step === "implement")!.extra;
    expect(coder.modelFallback).toEqual({ requested: ["@coding"], used: "faux/faux-1", reason: "no-resolver" });
    const judge = started.find((s) => s.step === "gate")!.extra;
    expect(judge.modelFallback?.reason).toBe("no-model-declared");
    // [@fast, faux/faux-1]: @fast is skipped, the literal resolves → no fallback reported.
    const reviewer = started.find((s) => s.step === "review")!;
    expect(reviewer.extra?.modelFallback).toBeUndefined();
    expect(String(reviewer.model)).toContain("faux-1");
  });

  it("a judge that finishes \"blocked\" (still naming `fix`) does not loop; the gate's on_error routes to the report", async () => {
    reviews = 0;
    const flow = parseFlowYamlString(FLOW_YAML, "<e2e>");
    const agents = [CODER, REVIEWER, JUDGE].map((m) => parseAgentString(m, "<e2e>"));
    const events: DecisionEvent[] = [];
    const started: string[] = [];
    const result = await runFaux({
      flow, agents, maxTurns: 48,
      // the classifier is never trusted, so the judge decides — and reports it cannot
      entryOverrides: { "typesafe/jev-latest": async () => ({ ok: true, answer: { label: "fix", confidence: 0.3 } }) as EntryResult },
      responder: (t) => t.includes("Is the review clean?")
        ? scriptFinish({ status: "blocked", summary: "cannot judge without the test log", branch: "fix" })
        : responder(t),
      onDecision: (e) => events.push(e),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(result.status).not.toBe("error");
    // No loop-back: implement and review ran once; on_error took the gate to the report.
    expect(started.filter((s) => s === "implement")).toHaveLength(1);
    expect(started.filter((s) => s === "review")).toHaveLength(1);
    expect(result.results.gate.status).toBe("error");
    expect(result.results.report?.status).toBe("complete");
    expect(events).toHaveLength(1);
    expect(events[0].routedBy).toBeUndefined();
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["typesafe/jev-latest", "untrusted"], ["agent", "invalid-label"]]);
    expect(events[0].attempts[1].reason).toBe("the decision agent finished with status blocked");
  });

  it("refuses to start when an authored agent declares a reserved output", async () => {
    const flow = parseFlowYamlString(FLOW_YAML, "<e2e>");
    const badCoder = parseAgentString(agentMd("coder", "@coding", "outputs:\n  - name: status\n"), "<e2e>");
    const agents = [badCoder, ...[REVIEWER, JUDGE].map((m) => parseAgentString(m, "<e2e>"))];
    let spawned = 0;
    const result = await runFaux({ flow, agents, responder: (t) => { spawned++; return responder(t); } });
    expect(result.status).toBe("error");
    expect(spawned).toBe(0);
    expect(result.lastResult?.result.summary).toMatch(/coder.*"status".*outcome/);
  });
});
