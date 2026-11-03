/**
 * Realistic end-to-end faux flows (part 1 of 2).
 *
 * Each scenario is authored the way a user writes it: a `flow.yaml` plus
 * markdown agents (and co-located `<id>.ts` code handlers) in a temp flow
 * directory. The files are validated with validateFlowContent /
 * validateAgentContent, parsed, and run on the real runFlow via runFaux.
 * Responders route on the dispatched task text, never on call order.
 *
 *   1. feature delivery: research → plan → implement → review → gate loop → report
 *   2. bug triage: intake → classify (typed outputs) → code-decision → hotfix | backlog → notify
 *   3. PR review: diff → 3 parallel reviewers → aggregate (fan-in) → ship/block gate
 *   4. doc writer: outline → draft → critique → interactive fork (revise/publish/Other) → revise loop
 *   5. customer import: extract (typed object output) → transform → validate loop → load → receipt
 *   6. haiku: poet (declared `haiku`) → critic → judge (state) → publish (fullOutput)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runFaux, scriptFinish, type FauxResponseStep } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { AgentConfig, DecisionEvent, FlowConfig } from "../extensions/flow-engine/types.js";

// ---- authoring helpers ------------------------------------------------------

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

/** `"name"` or `"name:type"` → an expanded `outputs:` entry. */
const outputMd = (spec: string) => {
  const [name, type] = spec.split(":");
  return `  - name: ${name}\n${type ? `    type: ${type}\n` : ""}`;
};
interface AgentOpts { model?: string | null; outputs?: string[]; desc?: string }
const agentMd = (name: string, o: AgentOpts = {}) => {
  const model = o.model === undefined ? "faux/faux-1" : o.model;
  return `---\nname: ${name}\ndescription: ${o.desc ?? `${name} agent`}\n${model ? `model: ${model}\n` : ""}tools: read\n` +
    (o.outputs ? `outputs:\n${o.outputs.map(outputMd).join("")}` : "") +
    `---\n\nYou are the ${name}. Do the task you are given and call finish.\n`;
};

const errorsOf = (d: Array<{ severity: string }>) => d.filter((x) => x.severity === "error");

/** Write flow.yaml (+ handlers) to a temp flow dir, validate everything, parse. */
function author(yaml: string, agentMds: string[], handlers: Record<string, string> = {}): { flow: FlowConfig; agents: AgentConfig[] } {
  const dir = mkdtempSync(join(tmpdir(), "e2e-realistic-"));
  tmpDirs.push(dir);
  const source = join(dir, "flow.yaml");
  writeFileSync(source, yaml, "utf8");
  for (const [id, src] of Object.entries(handlers)) writeFileSync(join(dir, `${id}.ts`), src, "utf8");
  for (const md of agentMds) expect(errorsOf(validateAgentContent(md).diagnostics), md).toEqual([]);
  const agents = agentMds.map((m) => parseAgentString(m, "<e2e>"));
  const diag = validateFlowContent(yaml, () => new Map(agents.map((a) => [a.name, a])), () => true);
  expect(errorsOf(diag.diagnostics)).toEqual([]);
  return { flow: parseFlowYamlString(yaml, source), agents };
}

/** Responders see the dispatched task text; the engine prefixes it with "Task: ". */
const task = (fn: (t: string) => FauxResponseStep) => (raw: string) => fn(raw.replace(/^Task: /, ""));

const ok = (summary: string, extra: Record<string, unknown> = {}) => scriptFinish({ status: "complete", summary, ...extra });

/** Lifecycle + task recorder shared by every scenario. */
function observe() {
  const log: string[] = [];
  const started: Array<{ name: string; step: string; model?: string; extra?: any }> = [];
  const tasks: Record<string, string[]> = {};
  const decisions: DecisionEvent[] = [];
  return {
    log, started, tasks, decisions,
    record(marker: string, text: string) { (tasks[marker] ??= []).push(text); },
    onAgentStarted: (name: string, step: string, model?: string, extra?: any) => { log.push(`start:${step}`); started.push({ name, step, model, extra }); },
    onAgentComplete: (_name: string, step: string) => { log.push(`end:${step}`); },
    onDecision: (e: DecisionEvent) => { decisions.push(e); },
    /** Agent-step start order (dedups the separator card + spawn double-announce). */
    steps: () => started.map((s) => s.step),
    count: (step: string) => started.filter((s) => s.step === step).length,
  };
}

// ---- 1. feature delivery with a review/fix loop ------------------------------

const FEATURE_YAML = `name: feature-delivery
description: research, plan, implement, review and loop until the reviewer is satisfied
steps:
  - id: research
    type: agent
    agent: researcher
    task: "RESEARCH the codebase for: \${{task}}"
  - id: plan
    type: agent
    agent: planner
    blockedBy: [research]
    task: "PLAN based on findings: \${{result.research.summary}} (files: \${{result.research.files_of_interest}})"
  - id: implement
    type: agent
    agent: coder
    blockedBy: [plan]
    task: "IMPLEMENT pass \${{loop.gate.iteration}} following plan: \${{result.plan.summary}}"
  - id: review
    type: agent
    agent: reviewer
    blockedBy: [implement]
    task: "REVIEW pass \${{loop.gate.iteration}}: \${{result.implement.summary}}"
  - id: gate
    type: agent-decision
    agent: judge
    task: "GATE pass \${{loop.gate.iteration}}/\${{loop.gate.max}}: is the change ready to ship?"
    state:
      review: "\${{result.review.summary}}"
      changed: "\${{result.implement.changed_files}}"
    branches:
      done: { to: report, means: "The reviewer found no blocking issues" }
      fix: { to: implement, means: "The reviewer reported a blocking issue" }
    max_iterations: 2
  - id: report
    type: agent
    agent: writer
    blockedBy: [review]
    task: "REPORT for \${{task}}: final review=\${{result.review.summary}}"
`;

const FEATURE_AGENTS = [
  agentMd("researcher", { outputs: ["files_of_interest"] }),
  agentMd("planner"),
  agentMd("coder", { outputs: ["changed_files:number"] }),
  agentMd("reviewer"),
  agentMd("judge", { desc: "decides whether a change is ready" }),
  agentMd("writer"),
];

function featureResponder(o: ReturnType<typeof observe>) {
  return (t: string) => {
    if (t.startsWith("RESEARCH")) { o.record("research", t); return ok("rate limiter belongs in middleware", { files_of_interest: "src/api.ts, src/limits.ts" }); }
    if (t.startsWith("PLAN")) { o.record("plan", t); return ok("add token-bucket middleware"); }
    if (t.startsWith("IMPLEMENT")) {
      o.record("implement", t);
      const pass = /pass (\d+)/.exec(t)?.[1];
      return ok(`implementation v${pass}`, { changed_files: pass === "1" ? 3 : 4 });
    }
    if (t.startsWith("REVIEW")) { o.record("review", t); return ok(t.includes("implementation v1") ? "BLOCKER: no tests for the limiter" : "LGTM"); }
    if (t.startsWith("GATE")) {
      o.record("gate", t);
      return ok("judged", { branch: /- review: BLOCKER/.test(t) ? "fix" : "done" });
    }
    if (t.startsWith("REPORT")) { o.record("report", t); return ok("report written"); }
    return ok("unexpected task");
  };
}

describe("e2e realistic 1: feature delivery with a review/fix loop", () => {
  it("loops once on a blocking review, then reports; the judge sees state and means", async () => {
    const { flow, agents } = author(FEATURE_YAML, FEATURE_AGENTS);
    const o = observe();
    const result = await runFaux({
      flow, agents, task: "add rate limiting to the public API", maxTurns: 48,
      responder: task(featureResponder(o)),
      onAgentStarted: o.onAgentStarted, onAgentComplete: o.onAgentComplete, onDecision: o.onDecision,
    });

    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(o.steps()).toEqual(["research", "plan", "implement", "review", "gate", "implement", "review", "gate", "report"]);

    // Templates: flow task, typed array output JIT-serialized, loop counters.
    expect(o.tasks.research[0]).toBe("RESEARCH the codebase for: add rate limiting to the public API");
    expect(o.tasks.plan[0]).toBe("PLAN based on findings: rate limiter belongs in middleware (files: src/api.ts, src/limits.ts)");
    expect(o.tasks.implement[0]).toBe("IMPLEMENT pass 1 following plan: add token-bucket middleware");
    expect(o.tasks.implement[1]).toMatch(/^IMPLEMENT pass 2 /);
    expect(o.tasks.review).toEqual(["REVIEW pass 1: implementation v1", "REVIEW pass 2: implementation v2"]);

    // The decision agent sees its task, every branch's `means`, and the declared state.
    const [g1, g2] = o.tasks.gate;
    expect(g1).toContain("GATE pass 1/2: is the change ready to ship?");
    expect(g1).toContain("- done: The reviewer found no blocking issues");
    expect(g1).toContain("- fix: The reviewer reported a blocking issue");
    expect(g1).toContain("State:");
    expect(g1).toContain("- review: BLOCKER: no tests for the limiter");
    expect(g1).toContain("- changed: 3");
    expect(g2).toContain("GATE pass 2/2");
    expect(g2).toContain("- review: LGTM");
    expect(g2).toContain("- changed: 4");

    // flow:decision events: agent-routed fix, then done.
    expect(o.decisions.map((d) => [d.stepId, d.label, d.routedBy])).toEqual([["gate", "fix", "agent"], ["gate", "done", "agent"]]);

    // Results reflect the last iteration.
    expect(result.results.review.summary).toBe("LGTM");
    expect(result.results.implement.outputs.changed_files).toBe(4);
    expect(o.tasks.report[0]).toBe("REPORT for add rate limiting to the public API: final review=LGTM");
    expect(result.results.report.summary).toBe("report written");
  });

  it("a step before the loop body keeps its result after the loop re-enters (plan summary still wired on pass 2)", async () => {
    const { flow, agents } = author(FEATURE_YAML, FEATURE_AGENTS);
    const o = observe();
    const result = await runFaux({ flow, agents, task: "add rate limiting", maxTurns: 48, responder: task(featureResponder(o)) });
    expect(result.status, result.lastResult.result.summary).toBe("success");
    // docs/flows.md: a completed step's result stays referenceable; plan ran once and completed.
    expect(o.tasks.implement[1]).toBe("IMPLEMENT pass 2 following plan: add token-bucket middleware");
    expect(result.results.plan.status).toBe("complete");
    expect(result.results.research.status).toBe("complete");
  });
});

// ---- 2. bug triage: classify → code-decision on severity ---------------------

const TRIAGE_YAML = `name: bug-triage
description: classify an incoming bug, then hotfix it now or file it in the backlog
steps:
  - id: intake
    type: agent
    agent: intake-clerk
    task: "INTAKE the bug report: \${{task}}"
  - id: classify
    type: agent
    agent: classifier
    blockedBy: [intake]
    task: "CLASSIFY this bug: \${{result.intake.summary}}"
  - id: route
    type: code-decision
    blockedBy: [classify]
    inputs:
      severity: "\${{result.classify.severity}}"
      area: "\${{result.classify.area}}"
    outputs:
      - name: priority
    branches:
      hotfix: hotfix
      backlog: backlog
  - id: hotfix
    type: agent
    agent: oncall
    blockedBy: [route]
    task: "HOTFIX \${{result.route.priority}} in \${{result.classify.area}}"
  - id: backlog
    type: agent
    agent: product-manager
    blockedBy: [route]
    task: "BACKLOG a \${{result.route.priority}} ticket for \${{result.classify.area}}"
  - id: notify
    type: agent
    agent: notifier
    blockedBy: [hotfix, backlog]
    task: "NOTIFY reporter: hotfix=[\${{result.hotfix.summary}}] backlog=[\${{result.backlog.summary}}] statuses=\${{result.hotfix.status}}/\${{result.backlog.status}}"
`;

const ROUTE_TS = `export default async function route(input, ctx) {
  const sev = String(input.severity).toLowerCase();
  ctx.setSummary("severity " + sev + " in " + input.area);
  if (sev === "critical" || sev === "high") return { branch: "hotfix", priority: sev === "critical" ? "P0" : "P1" };
  return { branch: "backlog", priority: "P3" };
}
`;

const TRIAGE_AGENTS = [
  agentMd("intake-clerk"),
  agentMd("classifier", { outputs: ["severity", "area"] }),
  agentMd("oncall"),
  agentMd("product-manager"),
  agentMd("notifier"),
];

describe("e2e realistic 2: bug triage routed by a code-decision on severity", () => {
  const run = async (report: string) => {
    const { flow, agents } = author(TRIAGE_YAML, TRIAGE_AGENTS, { route: ROUTE_TS });
    const o = observe();
    const result = await runFaux({
      flow, agents, task: report,
      responder: task((t) => {
        if (t.startsWith("INTAKE")) { o.record("intake", t); return ok(t.replace("INTAKE the bug report: ", "normalized: ")); }
        if (t.startsWith("CLASSIFY")) {
          o.record("classify", t);
          return /checkout/i.test(t) ? ok("classified", { severity: "Critical", area: "payments" }) : ok("classified", { severity: "low", area: "docs" });
        }
        if (t.startsWith("HOTFIX")) { o.record("hotfix", t); return ok("patched and deployed"); }
        if (t.startsWith("BACKLOG")) { o.record("backlog", t); return ok("filed DOC-12"); }
        if (t.startsWith("NOTIFY")) { o.record("notify", t); return ok("reporter notified"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onAgentComplete: o.onAgentComplete,
    });
    return { result, o };
  };

  it("a critical checkout bug takes the hotfix path; backlog is skipped and expands to empty", async () => {
    const { result, o } = await run("Checkout returns 500 for every EU customer");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(o.tasks.classify[0]).toBe("CLASSIFY this bug: normalized: Checkout returns 500 for every EU customer");
    expect(result.results.classify.outputs).toEqual({ severity: "Critical", area: "payments" });
    expect(result.results.route.outputs.priority).toBe("P0");
    expect(result.results.route.summary).toBe("severity critical in payments");
    expect(o.tasks.hotfix).toEqual(["HOTFIX P0 in payments"]);
    expect(o.tasks.backlog).toBeUndefined();
    expect(result.results.backlog.status).toBe("skipped");
    expect(o.tasks.notify).toEqual(["NOTIFY reporter: hotfix=[patched and deployed] backlog=[] statuses=complete/skipped"]);
    expect(o.steps().filter((s) => s !== "route")).toEqual(["intake", "classify", "hotfix", "notify"]);
  });

  it("a low-severity docs typo goes to the backlog; hotfix never runs", async () => {
    const { result, o } = await run("Typo on the FAQ page");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.route.outputs.priority).toBe("P3");
    expect(o.tasks.backlog).toEqual(["BACKLOG a P3 ticket for docs"]);
    expect(o.tasks.hotfix).toBeUndefined();
    expect(result.results.hotfix.status).toBe("skipped");
    expect(o.tasks.notify).toEqual(["NOTIFY reporter: hotfix=[] backlog=[filed DOC-12] statuses=skipped/complete"]);
    expect(o.steps()).not.toContain("hotfix");
  });
});

// ---- 3. parallel PR review: fan-out → fan-in → ship/block --------------------

const PR_YAML = `name: pr-review
description: three specialist reviewers in parallel, aggregated into a ship/block decision
max_concurrent: 3
steps:
  - id: diff
    type: code
    outputs:
      - name: files
      - name: loc
  - id: security
    type: agent
    agent: security-reviewer
    blockedBy: [diff]
    task: "SECURITY review of \${{result.diff.files}} (\${{result.diff.loc}} LOC)"
  - id: perf
    type: agent
    agent: perf-reviewer
    blockedBy: [diff]
    task: "PERFORMANCE review of \${{result.diff.files}}"
  - id: style
    type: agent
    agent: style-reviewer
    blockedBy: [diff]
    task: "STYLE review of \${{result.diff.files}}"
  - id: aggregate
    type: code
    blockedBy: [security, perf, style]
    inputs:
      security: "\${{result.security.findings}}"
      perf: "\${{result.perf.findings}}"
      style: "\${{result.style.findings}}"
    outputs:
      - name: blockers
      - name: digest
  - id: ship-gate
    type: agent-decision
    agent: release-manager
    blockedBy: [aggregate]
    task: "SHIP-GATE: should \${{task}} merge?"
    state:
      blockers: "\${{result.aggregate.blockers}}"
      digest: "\${{result.aggregate.digest}}"
    branches:
      ship: { to: merge, means: "No blocking findings" }
      block: { to: request-changes, means: "At least one blocking finding" }
  - id: merge
    type: agent
    agent: merger
    blockedBy: [aggregate]
    task: "MERGE: \${{result.aggregate.digest}}"
  - id: request-changes
    type: agent
    agent: merger
    blockedBy: [aggregate]
    task: "REQUEST-CHANGES: \${{result.aggregate.digest}}"
`;

const DIFF_TS = `export default async function diff(_input, ctx) {
  ctx.setSummary("diff for " + ctx.task);
  return { files: ["src/auth.ts", "src/cache.ts"], loc: 240 };
}
`;
// Reviewers report findings as JSON text; the aggregator parses each one.
const AGGREGATE_TS = `export default async function aggregate(input) {
  const all = [];
  for (const k of ["security", "perf", "style"]) {
    if (typeof input[k] !== "string") throw new Error(k + " findings must arrive as text, got " + typeof input[k]);
    all.push(...JSON.parse(input[k]));
  }
  const blockers = all.filter((f) => f.severity === "blocker").length;
  const digest = all.length ? all.map((f) => f.severity + ": " + f.note).join(" | ") : "no findings";
  return { blockers, digest };
}
`;

describe("e2e realistic 3: parallel PR review with fan-in and a ship/block gate", () => {
  const run = async (securityFindings: unknown[]) => {
    const { flow, agents } = author(PR_YAML, [
      agentMd("security-reviewer", { outputs: ["findings"] }),
      agentMd("perf-reviewer", { outputs: ["findings"] }),
      agentMd("style-reviewer", { outputs: ["findings"] }),
      agentMd("release-manager"),
      agentMd("merger"),
    ], { diff: DIFF_TS, aggregate: AGGREGATE_TS });
    const o = observe();
    const result = await runFaux({
      flow, agents, task: "PR #42",
      responder: task((t) => {
        if (t.startsWith("SECURITY")) { o.record("security", t); return ok("security reviewed", { findings: JSON.stringify(securityFindings) }); }
        if (t.startsWith("PERFORMANCE")) { o.record("perf", t); return ok("perf reviewed", { findings: JSON.stringify([{ severity: "minor", note: "cache TTL hard-coded" }]) }); }
        if (t.startsWith("STYLE")) { o.record("style", t); return ok("style reviewed", { findings: "[]" }); }
        if (t.startsWith("SHIP-GATE")) { o.record("gate", t); return ok("decided", { branch: /- blockers: 0/.test(t) ? "ship" : "block" }); }
        if (t.startsWith("MERGE")) { o.record("merge", t); return ok("merged"); }
        if (t.startsWith("REQUEST-CHANGES")) { o.record("request-changes", t); return ok("changes requested"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onAgentComplete: o.onAgentComplete, onDecision: o.onDecision,
    });
    return { result, o };
  };

  it("a security blocker fans in to the aggregator and blocks the merge", async () => {
    const { result, o } = await run([{ severity: "blocker", note: "SQL injection in login" }]);
    expect(result.status, result.lastResult.result.summary).toBe("success");

    // Fan-out: all three reviewers start before any of them finishes.
    const reviewers = ["security", "perf", "style"];
    const firstEnd = Math.min(...reviewers.map((r) => o.log.indexOf(`end:${r}`)));
    for (const r of reviewers) expect(o.log.indexOf(`start:${r}`)).toBeLessThan(firstEnd);
    // Fan-in: the aggregator starts only after all three end.
    const aggStart = o.log.indexOf("start:aggregate");
    expect(aggStart).toBeGreaterThan(-1);
    for (const r of reviewers) expect(o.log.indexOf(`end:${r}`)).toBeLessThan(aggStart);

    // Templates: typed code outputs serialized into each reviewer's task.
    expect(o.tasks.security[0]).toBe('SECURITY review of ["src/auth.ts","src/cache.ts"] (240 LOC)');
    expect(o.tasks.perf[0]).toBe('PERFORMANCE review of ["src/auth.ts","src/cache.ts"]');
    expect(result.results.diff.summary).toBe("diff for PR #42");

    // Aggregator received the text findings (it throws otherwise) and produced typed outputs.
    expect(result.results.aggregate.outputs).toEqual({ blockers: 1, digest: "blocker: SQL injection in login | minor: cache TTL hard-coded" });
    expect(o.tasks.gate[0]).toContain("SHIP-GATE: should PR #42 merge?");
    expect(o.tasks.gate[0]).toContain("- blockers: 1");
    expect(o.tasks.gate[0]).toContain("- digest: blocker: SQL injection in login | minor: cache TTL hard-coded");
    expect(o.decisions.map((d) => d.label)).toEqual(["block"]);
    expect(o.tasks["request-changes"]).toEqual(["REQUEST-CHANGES: blocker: SQL injection in login | minor: cache TTL hard-coded"]);
    expect(o.tasks.merge).toBeUndefined();
    expect(result.results.merge.status).toBe("skipped");
  });

  it("clean reviews ship", async () => {
    const { result, o } = await run([]);
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.aggregate.outputs.blockers).toBe(0);
    expect(o.decisions.map((d) => [d.label, d.routedBy])).toEqual([["ship", "agent"]]);
    expect(o.tasks.merge).toEqual(["MERGE: minor: cache TTL hard-coded"]);
    expect(result.results["request-changes"].status).toBe("skipped");
  });
});

// ---- 4. doc writer: interactive fork with a revise loop ----------------------

const DOC_YAML = `name: doc-writer
description: outline, draft and critique a doc; the author decides to revise or publish
decision_agent: editor
steps:
  - id: outline
    type: agent
    agent: writer
    task: "OUTLINE a doc about \${{task}}"
  - id: draft
    type: agent
    agent: writer
    blockedBy: [outline]
    task: "DRAFT from outline: \${{result.outline.summary}}"
  - id: critique
    type: agent
    agent: critic
    blockedBy: [draft]
    task: "CRITIQUE round \${{loop.recheck.iteration}}; latest revision: [\${{result.revise.summary}}]"
  - id: choose
    type: fork
    question: "The critic says: \${{result.critique.summary}}. Revise or publish?"
    options: [revise, publish]
    allowCustom: true
    branches:
      revise: revise
      publish: publish
  - id: revise
    type: agent
    agent: writer
    task: "REVISE addressing: \${{result.critique.summary}}"
  - id: recheck
    type: code-decision
    inputs:
      revision: "\${{result.revise.summary}}"
    branches:
      again: critique
      done: publish
    max_iterations: 2
  - id: publish
    type: agent
    agent: publisher
    task: "PUBLISH final doc (critic: \${{result.critique.summary}}; revision: \${{result.revise.summary}})"
`;

const RECHECK_TS = `export default async function recheck(input) {
  return { branch: input.revision ? "again" : "done" };
}
`;

describe("e2e realistic 4: doc writer with an interactive revise/publish fork", () => {
  it("user picks revise, the critique re-runs, then free text 'ship it' is mapped to publish by the editor", async () => {
    const { flow, agents } = author(DOC_YAML, [
      agentMd("writer"), agentMd("critic"), agentMd("publisher"), agentMd("editor", { desc: "maps author intent to a branch" }),
    ], { recheck: RECHECK_TS });
    const o = observe();
    const asked: Array<{ question: string; options?: string[]; extra?: any }> = [];
    const replies = [
      { answer: "revise", notes: "tighten the intro" },
      { answer: "__custom_decide__", notes: "looks good now, ship it" },
    ];
    const result = await runFaux({
      flow, agents, task: "the flows dashboard", maxTurns: 48,
      isAutonomous: () => false,
      askUser: async (question, _type, options, extra) => { asked.push({ question, options, extra }); return replies[asked.length - 1]; },
      responder: task((t) => {
        if (/The user was asked/.test(t)) { o.record("editor", t); return ok("mapped", { branch: /ship it/.test(t) ? "publish" : "revise" }); }
        if (t.startsWith("OUTLINE")) { o.record("outline", t); return ok("intro, setup, usage"); }
        if (t.startsWith("DRAFT")) { o.record("draft", t); return ok("draft v1 written"); }
        if (t.startsWith("CRITIQUE")) { o.record("critique", t); return ok(/revision: \[\]/.test(t) ? "Intro is too long" : "Much better"); }
        if (t.startsWith("REVISE")) { o.record("revise", t); return ok("shortened the intro"); }
        if (t.startsWith("PUBLISH")) { o.record("publish", t); return ok("published"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onAgentComplete: o.onAgentComplete, onDecision: o.onDecision,
    });

    expect(result.status, result.lastResult.result.summary).toBe("success");
    // The user was asked twice; the question is template-expanded with the critique.
    expect(asked).toHaveLength(2);
    expect(asked[0].question).toBe("The critic says: Intro is too long. Revise or publish?");
    expect(asked[0].options).toEqual(["revise", "publish"]);
    expect(asked[0].extra?.allowCustom).toBe(true);
    expect(asked[1].question).toBe("The critic says: Much better. Revise or publish?");

    // Loop: draft once, critique twice, revise once; the editor mapped the free text.
    expect(o.tasks.outline).toHaveLength(1);
    expect(o.tasks.draft).toEqual(["DRAFT from outline: intro, setup, usage"]);
    expect(o.tasks.critique).toEqual(["CRITIQUE round 1; latest revision: []", "CRITIQUE round 2; latest revision: [shortened the intro]"]);
    expect(o.tasks.revise).toEqual(["REVISE addressing: Intro is too long"]);
    expect(o.tasks.editor).toHaveLength(1);
    expect(o.tasks.editor[0]).toContain("looks good now, ship it");
    expect(o.started.filter((s) => s.step === "choose").map((s) => s.name)).toContain("editor");

    expect(result.forks.choose).toEqual({ answer: "publish", notes: "looks good now, ship it" });
    expect(o.tasks.publish).toEqual(["PUBLISH final doc (critic: Much better; revision: shortened the intro)"]);
    expect(o.decisions.filter((d) => d.stepId === "choose").map((d) => d.label)).toEqual(["publish"]);
    expect(o.log.indexOf("start:publish")).toBeGreaterThan(o.log.lastIndexOf("start:critique"));
  });
});

// ---- 5. customer import: typed outputs and a validation loop -----------------

const IMPORT_YAML = `name: customer-import
description: extract customers from a CSV export, transform, validate, then load into the CRM
steps:
  - id: extract
    type: agent
    agent: extractor
    task: "EXTRACT customers from \${{task}}. Problems from the last attempt: [\${{result.validate.problems}}]"
  - id: transform
    type: code
    blockedBy: [extract]
    inputs:
      records: "\${{result.extract.records}}"
      source: "\${{result.extract.source}}"
    outputs:
      - name: rows
      - name: count
      - name: source_file
      - name: records_type
  - id: validate
    type: code-decision
    blockedBy: [transform]
    inputs:
      rows: "\${{result.transform.rows}}"
    outputs:
      - name: problems
    branches:
      valid: load
      invalid: extract
    max_iterations: 2
  - id: load
    type: agent
    agent: loader
    task: "LOAD \${{result.transform.count}} rows into the CRM: \${{result.transform.rows}}"
  - id: receipt
    type: code
    blockedBy: [load]
    inputs:
      loaded: "\${{result.load.loaded}}"
      count: "\${{result.transform.count}}"
    outputs:
      - name: message
`;

// Accepts typed values (array/object) or the same data as JSON text.
const TRANSFORM_TS = `export default async function transform(input) {
  const records = typeof input.records === "string" ? JSON.parse(input.records) : input.records;
  const source = typeof input.source === "string" ? JSON.parse(input.source) : input.source;
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (typeof source !== "object" || source === null) throw new Error("source must be an object");
  const rows = records.map((r) => ({ id: Number(r.id), email: String(r.email ?? "").trim().toLowerCase(), name: r.name }));
  return { rows, count: rows.length, source_file: source.file, records_type: typeof input.records };
}
`;
const VALIDATE_TS = `export default async function validate(input) {
  const problems = input.rows.filter((r) => !r.email).map((r) => "row " + r.id + " has no email").join("; ");
  return { branch: problems ? "invalid" : "valid", problems };
}
`;
const RECEIPT_TS = `export default async function receipt(input) {
  if (typeof input.count !== "number" || typeof input.loaded !== "number") throw new Error("counts must be numbers");
  return { message: input.loaded + "/" + input.count + " loaded" };
}
`;

describe("e2e realistic 5: customer import with typed outputs and a validation loop", () => {
  const BAD = [{ id: "1", email: " Ada@Example.com ", name: "Ada" }, { id: "2", email: "", name: "Bob" }];
  const GOOD = [{ id: "1", email: " Ada@Example.com ", name: "Ada" }, { id: "2", email: "BOB@example.com", name: "Bob" }];

  const SOURCE = { file: "customers.csv", encoding: "utf-8" };
  /** typed: the extractor declares `records: array` / `source: object`; text: it emits JSON strings. */
  const run = async (canFix: boolean, mode: "typed" | "text" = "text") => {
    const typed = mode === "typed";
    const { flow, agents } = author(IMPORT_YAML, [
      agentMd("extractor", { outputs: typed ? ["records:array", "source:object"] : ["records", "source"] }),
      agentMd("loader", { outputs: ["loaded:number"] }),
    ], { transform: TRANSFORM_TS, validate: VALIDATE_TS, receipt: RECEIPT_TS });
    const o = observe();
    const result = await runFaux({
      flow, agents, task: "exports/customers.csv", maxTurns: 48,
      responder: task((t) => {
        if (t.startsWith("EXTRACT")) {
          o.record("extract", t);
          const fix = canFix && t.includes("row 2 has no email");
          const records = fix ? GOOD : BAD;
          return ok("extracted", typed ? { records, source: SOURCE } : { records: JSON.stringify(records), source: JSON.stringify(SOURCE) });
        }
        if (t.startsWith("LOAD")) { o.record("load", t); return ok("loaded", { loaded: 2 }); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onAgentComplete: o.onAgentComplete,
    });
    return { result, o };
  };

  it("invalid data loops back to extract with the problems; the fixed extract loads", async () => {
    const { result, o } = await run(true);
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(o.tasks.extract).toEqual([
      "EXTRACT customers from exports/customers.csv. Problems from the last attempt: []",
      "EXTRACT customers from exports/customers.csv. Problems from the last attempt: [row 2 has no email]",
    ]);
    // Code outputs are stored in real JSON types; the JSON text was parsed by the handler.
    expect(result.results.transform.outputs.records_type).toBe("string");
    expect(result.results.transform.outputs.source_file).toBe("customers.csv");
    expect(result.results.transform.outputs.count).toBe(2);
    expect(result.results.transform.outputs.rows).toEqual([
      { id: 1, email: "ada@example.com", name: "Ada" },
      { id: 2, email: "bob@example.com", name: "Bob" },
    ]);
    expect(result.results.validate.outputs.problems).toBe("");
    expect(o.tasks.load).toEqual([
      'LOAD 2 rows into the CRM: [{"id":1,"email":"ada@example.com","name":"Ada"},{"id":2,"email":"bob@example.com","name":"Bob"}]',
    ]);
    expect(result.results.receipt.outputs.message).toBe("2/2 loaded");
    expect(o.count("extract")).toBe(2);
  });

  it("data that never validates stops looping at max_iterations and falls through to load", async () => {
    const { result, o } = await run(false);
    expect(result.status, result.lastResult.result.summary).toBe("success");
    // max_iterations: 2 → at most 3 passes of the body.
    expect(o.count("extract")).toBe(3);
    expect(result.results.validate.outputs.problems).toBe("row 2 has no email");
    expect(o.tasks.load).toHaveLength(1);
    expect(o.tasks.load[0]).toContain('"email":""');
  });

  // Pins: `type: object` / `type: array` agent outputs survive parsing and the finish schema.
  it("an extractor declaring `records: array` / `source: object` hands typed values to the transform", async () => {
    const { result, o } = await run(true, "typed");
    // docs/flow-authoring.md → Outputs: `type` may be object/array; stored in its real JSON type.
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.extract.outputs.source).toEqual(SOURCE);
    expect(result.results.extract.outputs.records).toEqual(GOOD);
    expect(result.results.transform.outputs.records_type).toBe("object");
    expect(o.count("extract")).toBe(2);
  });
});

// ---- 6. haiku: declared output vs summary vs fullOutput ---------------------

const HAIKU_YAML = `name: haiku
description: write a haiku, have it critiqued, and let a judge decide whether to keep it
steps:
  - id: write
    type: agent
    agent: poet
    task: "WRITE a haiku about \${{task}}"
  - id: critique
    type: agent
    agent: critic
    blockedBy: [write]
    task: "CRITIQUE this haiku: \${{result.write.haiku}}"
  - id: judge
    type: agent-decision
    agent: judge
    task: "JUDGE: keep the haiku or rewrite it?"
    state:
      review: "\${{result.critique.summary}}"
      haiku: "\${{result.write.haiku}}"
    branches:
      keep: { to: publish, means: "The haiku is good" }
      rewrite: { to: write, means: "The haiku needs another draft" }
    max_iterations: 1
  - id: publish
    type: agent
    agent: publisher
    blockedBy: [write]
    task: "PUBLISH the poet's reply verbatim: \${{result.write.fullOutput}}"
`;

describe("e2e realistic 6: haiku — critic gets the haiku, judge gets the state", () => {
  it("wires the declared haiku (not the summary) and the reply text (fullOutput)", async () => {
    const HAIKU = "soft rain on the roof / the kettle hums its answer / evening settles in";
    const REPLY = "Here is my haiku for you.";
    const { flow, agents } = author(HAIKU_YAML, [
      agentMd("poet", { outputs: ["haiku"] }), agentMd("critic"), agentMd("judge"), agentMd("publisher"),
    ]);
    const o = observe();
    const result = await runFaux({
      flow, agents, task: "rain",
      responder: task((t) => {
        if (t.startsWith("WRITE")) {
          o.record("write", t);
          return fauxAssistantMessage([
            fauxText(REPLY),
            fauxToolCall("finish", { status: "complete", summary: "Wrote a haiku about rain", files: [], haiku: HAIKU }),
          ]);
        }
        if (t.startsWith("CRITIQUE")) { o.record("critique", t); return ok("vivid imagery, 5-7-5 holds"); }
        if (t.startsWith("JUDGE")) { o.record("judge", t); return ok("keep it", { branch: "keep" }); }
        if (t.startsWith("PUBLISH")) { o.record("publish", t); return ok("published"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onDecision: o.onDecision,
    });

    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(o.tasks.write).toEqual(["WRITE a haiku about rain"]);
    expect(result.results.write.summary).toBe("Wrote a haiku about rain");
    expect(result.results.write.outputs.haiku).toBe(HAIKU);

    // The critic receives the haiku itself, not the summary.
    expect(o.tasks.critique).toEqual([`CRITIQUE this haiku: ${HAIKU}`]);
    expect(o.tasks.critique[0]).not.toContain("Wrote a haiku about rain");

    // The judge's task carries the state values and the branch meanings.
    const judge = o.tasks.judge[0];
    expect(judge).toContain("JUDGE: keep the haiku or rewrite it?");
    expect(judge).toContain(`- haiku: ${HAIKU}`);
    expect(judge).toContain("- review: vivid imagery, 5-7-5 holds");
    expect(judge).toContain("- keep: The haiku is good");
    expect(judge).toContain("- rewrite: The haiku needs another draft");
    expect(o.decisions.map((d) => [d.label, d.routedBy])).toEqual([["keep", "agent"]]);

    // fullOutput is the reply text.
    expect(result.results.write.fullOutput).toContain(REPLY);
    expect(o.tasks.publish).toHaveLength(1);
    expect(o.tasks.publish[0]).toContain(`PUBLISH the poet's reply verbatim: ${REPLY}`);
    expect(o.tasks.publish[0]).not.toContain("Wrote a haiku about rain");
    expect(o.steps()).toEqual(["write", "critique", "judge", "publish"]);
  });
});
