/**
 * End-to-end faux scenarios for multi-route decisions (change:
 * multi-route-decisions). Written from the spec scenarios only: a decision with
 * `multi: true` chooses zero or more branches (lanes run in parallel, the rest
 * are skipped), a fan-out branch runs its target once per item, item results
 * aggregate in input order, loops stay single-route, classifiers never decide
 * a multi decision, and every behaviour is observable.
 *
 * Flows/agents are authored as YAML/markdown, validated, parsed and run on the
 * real runFlow with the faux provider; code handlers via runFauxFlow.
 */
import { describe, expect, it } from "vitest";
import { runFauxFlow, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";

// ── helpers ───────────────────────────────────────────────────────────────

const agentMd = (name: string, outputs: string[] = []) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n${
    outputs.length ? `outputs:\n${outputs.map((o) => `  - name: ${o}\n`).join("")}` : ""
  }---\n\nYou are ${name}.\n`;

const AGENTS = [agentMd("worker"), agentMd("judge"), agentMd("noter", ["notes"])].map((m) => parseAgentString(m, "<multi>"));
const BY_NAME = new Map(AGENTS.map((a) => [a.name, a]));

const diagnosticsOf = (yaml: string) => validateFlowContent(yaml, () => BY_NAME as never, () => true).diagnostics;
const errorsOf = (yaml: string) => diagnosticsOf(yaml).filter((d) => d.severity === "error").map((d) => d.message);

/** Validate (must be clean) then parse. */
function load(yaml: string) {
  expect(errorsOf(yaml), "flow validates").toEqual([]);
  return parseFlowYamlString(yaml, "<multi>");
}

const ok = (summary: string, extra: Record<string, unknown> = {}) => scriptFinish({ status: "complete", summary, ...extra });

function tracker() {
  const started: Array<{ step: string; extra: any }> = [];
  const tasks: string[] = [];
  return {
    started, tasks,
    count: (id: string) => started.filter((s) => s.step === id).length,
    onAgentStarted: (_a: string, step: string, _m?: string, extra?: any) => { started.push({ step, extra }); },
  };
}

/** First line of the dispatched task, without the harness's "Task: " prefix. */
const head = (t: string) => t.split("\n")[0].replace(/^Task: /, "");
/** Worker responder: echoes the first line of the task as the summary. */
const echo = (t: string, extra: Record<string, unknown> = {}) => ok(`did ${head(t)}`, extra);

const LANES = (decision: string) => `name: lanes
description: multi decision over three lanes
steps:
${decision}
  - id: backend
    type: agent
    agent: worker
    task: "LANE backend"
  - id: frontend
    type: agent
    agent: worker
    task: "LANE frontend"
  - id: docs
    type: agent
    agent: worker
    task: "LANE docs"
  - id: report
    type: agent
    agent: worker
    blockedBy: [backend, frontend, docs]
    task: "REPORT"
  - id: after
    type: code
`;

const CODE_ROUTER = `  - id: route
    type: code-decision
    multi: true
    branches:
      backend: backend
      frontend: frontend
      docs: docs`;

// ── 1. Lanes ──────────────────────────────────────────────────────────────

describe("multi decision: lanes", () => {
  it("code-decision picks two of three lanes: both run, the third is skipped, report runs once", async () => {
    const t = tracker();
    const r = await runFauxFlow({
      flow: load(LANES(CODE_ROUTER)), agents: AGENTS,
      codeHandlers: {
        route: `export default async () => ({ branches: ["backend", "frontend"] });`,
        after: `export default async () => ({});`,
      },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    expect(t.count("backend")).toBe(1);
    expect(t.count("frontend")).toBe(1);
    expect(t.count("docs")).toBe(0);
    expect(r.results.docs.status).toBe("skipped");
    expect(t.count("report")).toBe(1);
    expect(r.results.report.status).toBe("complete");
  });

  it("choosing nothing skips the whole next segment and runs the step after it", async () => {
    const t = tracker();
    const r = await runFauxFlow({
      flow: load(LANES(CODE_ROUTER)), agents: AGENTS,
      codeHandlers: {
        route: `export default async () => ({ branches: [] });`,
        after: `export default async () => ({});`,
      },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    for (const id of ["backend", "frontend", "docs", "report"]) expect(r.results[id].status, id).toBe("skipped");
    expect(r.results.after.status).toBe("complete");
  });

  it("an agent-decision picks several branches via finish({ branches }) and reports labels", async () => {
    const t = tracker();
    const decisions: DecisionEvent[] = [];
    const yaml = LANES(`  - id: route
    type: agent-decision
    agent: judge
    multi: true
    task: "DECIDE which lanes"
    branches:
      backend: backend
      frontend: frontend
      docs: docs`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: { after: `export default async () => ({});` },
      responder: (x) => (/DECIDE/.test(x) ? ok("picked", { branches: ["backend", "docs"] }) : echo(x)),
      onAgentStarted: t.onAgentStarted,
      onDecision: (e) => decisions.push(e),
    });
    expect(r.status).toBe("success");
    expect(t.count("backend")).toBe(1);
    expect(t.count("docs")).toBe(1);
    expect(r.results.frontend.status).toBe("skipped");
    expect((decisions[0] as any).labels).toEqual(["backend", "docs"]);
  });

  it("an agent-decision may choose nothing", async () => {
    const yaml = LANES(`  - id: route
    type: agent-decision
    agent: judge
    multi: true
    task: "DECIDE which lanes"
    branches:
      backend: backend
      frontend: frontend
      docs: docs`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: { after: `export default async () => ({});` },
      responder: (x) => (/DECIDE/.test(x) ? ok("none", { branches: [] }) : echo(x)),
    });
    expect(r.status).toBe("success");
    for (const id of ["backend", "frontend", "docs", "report"]) expect(r.results[id].status, id).toBe("skipped");
    expect(r.results.after.status).toBe("complete");
  });

  it("finish({ branch }) on a multi agent-decision is rejected (not routed)", async () => {
    const yaml = LANES(`  - id: route
    type: agent-decision
    agent: judge
    multi: true
    task: "DECIDE which lanes"
    branches:
      backend: backend
      frontend: frontend
      docs: docs`);
    const t = tracker();
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: { after: `export default async () => ({});` },
      responder: (x) => (/DECIDE/.test(x) ? ok("one", { branch: "backend" }) : echo(x)),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("error");
    expect(t.count("backend")).toBe(0);
  });

  it("a duplicate label soft-fails the decision naming the label", async () => {
    const r = await runFauxFlow({
      flow: load(LANES(CODE_ROUTER)), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ branches: ["docs", "docs"] });`, after: `export default async () => ({});` },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("error");
    expect(r.lastResult.output).toMatch(/docs/);
    expect(r.lastResult.output).toMatch(/duplicate/i);
  });

  it("an off-map label is a hard failure", async () => {
    const r = await runFauxFlow({
      flow: load(LANES(CODE_ROUTER)), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ branches: ["nope"] });`, after: `export default async () => ({});` },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("error");
    expect(r.lastResult.outcome).toBe("hard");
    expect(r.lastResult.output).toMatch(/nope/);
  });

  it("a multi handler may still return a single { branch }", async () => {
    const t = tracker();
    const r = await runFauxFlow({
      flow: load(LANES(CODE_ROUTER)), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ branch: "docs" });`, after: `export default async () => ({});` },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    expect(t.count("docs")).toBe(1);
    expect(r.results.backend.status).toBe("skipped");
  });

  it("without multi, a declared `branches` key is an ordinary data output", async () => {
    const yaml = `name: plain
description: branches as data
steps:
  - id: route
    type: code-decision
    outputs:
      - name: branches
    branches:
      a: a
      b: b
  - id: a
    type: agent
    agent: worker
    task: "LANE a"
  - id: b
    type: code
`;
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ branch: "a", branches: ["x"] });`, b: `export default async () => ({});` },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("success");
    expect(r.results.route.outputs.branches).toEqual(["x"]);
    expect(r.results.a.status).toBe("complete");
  });
});

// ── 2. Fan-out ────────────────────────────────────────────────────────────

const FANOUT = (branch: string, extraBefore = "", targetExtra = "") => `name: fanout
description: one explorer per project
steps:
  - id: scan
    type: code
    outputs:
      - name: projects
${extraBefore}  - id: decide
    type: code-decision
    multi: true
    branches:
${branch}
  - id: explore
    type: agent
    agent: worker
    task: "EXPLORE \${{item}} #\${{item_index}}"
${targetExtra}  - id: merge
    type: agent
    agent: worker
    blockedBy: [explore]
    task: "MERGE \${{result.explore.items}}"
  - id: collect
    type: code
    inputs:
      items: "\${{result.explore.items}}"
    outputs:
      - name: seen
`;

describe("multi decision: fan-out", () => {
  it("runs the target once per for_each item; merge runs once; items aggregate in input order", async () => {
    const t = tracker();
    const tasks: string[] = [];
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: ["api", "web", "cli"] });`,
        decide: `export default async () => ({ branch: "explore" });`,
        collect: `export default async (input) => ({ seen: input.items });`,
      },
      responder: (x) => { if (/EXPLORE|MERGE/.test(x)) tasks.push(head(x)); return echo(x); },
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    expect(t.count("explore")).toBe(3);
    expect(tasks.filter((x) => x.startsWith("EXPLORE")).sort()).toEqual(["EXPLORE api #0", "EXPLORE cli #2", "EXPLORE web #1"]);
    expect(t.count("merge")).toBe(1);
    const seen = r.results.collect.outputs.seen as Array<{ status: string; summary: string }>;
    expect(Array.isArray(seen)).toBe(true);
    expect(seen.map((s) => s.summary)).toEqual(["did EXPLORE api #0", "did EXPLORE web #1", "did EXPLORE cli #2"]);
    expect(r.results.explore.status).toBe("complete");
    expect(r.results.explore.outputs).toEqual({});
  });

  it("instance events carry itemIndex and itemCount", async () => {
    const t = tracker();
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`);
    await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: ["a", "b"] });`,
        decide: `export default async () => ({ branch: "explore" });`,
        collect: `export default async () => ({ seen: 1 });`,
      },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    const ex = t.started.filter((s) => s.step === "explore").map((s) => [s.extra?.itemIndex, s.extra?.itemCount]);
    expect(ex.sort()).toEqual([[0, 2], [1, 2]]);
  });

  it("code-decision routes carry items; ${{item.<field>}} reads object fields", async () => {
    const tasks: string[] = [];
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: dynamic`, "", "").replace('task: "EXPLORE ${{item}} #${{item_index}}"', 'task: "EXPLORE ${{item.change}} in ${{item.worktree}}${{item.missing}}"');
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: [] });`,
        decide: `export default async () => ({ routes: [{ branch: "explore", items: [{ change: "a", worktree: "/w/a" }, { change: "b", worktree: "/w/b" }] }] });`,
        collect: `export default async () => ({ seen: 1 });`,
      },
      responder: (x) => { if (/EXPLORE/.test(x) && !/MERGE/.test(x)) tasks.push(head(x)); return echo(x); },
    });
    expect(r.status).toBe("success");
    expect(tasks.sort()).toEqual(["EXPLORE a in /w/a", "EXPLORE b in /w/b"]);
  });

  it("an empty item list starts no instance; status complete with items []; blocked steps still run", async () => {
    const t = tracker();
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: [] });`,
        decide: `export default async () => ({ branch: "explore" });`,
        collect: `export default async (input) => ({ seen: input.items });`,
      },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    expect(t.count("explore")).toBe(0);
    expect(r.results.explore.status).toBe("complete");
    expect(r.results.collect.outputs.seen).toEqual([]);
    expect(t.count("merge")).toBe(1);
  });

  it("a skipped fan-out target still reads as items []", async () => {
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: ["a"] });`,
        decide: `export default async () => ({ branches: [] });`,
        collect: `export default async (input) => ({ seen: input.items });`,
      },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("success");
    expect(r.results.explore.status).toBe("skipped");
    expect(r.results.collect.outputs.seen).toEqual([]);
  });

  it("items over max_items soft-fail the decision; no lane runs; decision on_error routes", async () => {
    const t = tracker();
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"
        max_items: 2`).replace("    multi: true\n", "    multi: true\n    on_error: collect\n");
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: ["a", "b", "c"] });`,
        decide: `export default async () => ({ branch: "explore" });`,
        collect: `export default async () => ({ seen: "fallback" });`,
      },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(t.count("explore")).toBe(0);
    expect(t.count("merge")).toBe(0);
    expect(r.results.decide.status).toBe("error");
    expect(r.results.decide.summary).toMatch(/explore/);
    expect(r.results.decide.summary).toMatch(/3/);
    expect(r.results.decide.summary).toMatch(/2/);
    expect(r.results.collect.outputs.seen).toBe("fallback");
  });

  it("for_each that is not an array soft-fails the decision", async () => {
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: "abc" });`,
        decide: `export default async () => ({ branch: "explore" });`,
        collect: `export default async () => ({ seen: 1 });`,
      },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("error");
    expect(r.lastResult.output).toMatch(/decide/);
    expect(r.lastResult.output).toMatch(/array/i);
  });

  it("items given for a non-fan-out branch soft-fail naming the branch", async () => {
    const r = await runFauxFlow({
      flow: load(LANES(CODE_ROUTER)), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ routes: [{ branch: "docs", items: [1] }] });`, after: `export default async () => ({});` },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("error");
    expect(r.lastResult.output).toMatch(/docs/);
  });

  it("one soft-failing item lets siblings finish, then routes by the target's on_error", async () => {
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`, "", "    on_error: collect\n");
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        scan: `export default async () => ({ projects: ["a", "b", "c"] });`,
        decide: `export default async () => ({ branch: "explore" });`,
        collect: `export default async (input) => ({ seen: input.items });`,
      },
      responder: (x) => (/EXPLORE b/.test(x) ? scriptFinish({ status: "blocked", summary: "need input" }) : echo(x)),
    });
    expect(r.status).toBe("success");
    const items = r.results.collect.outputs.seen as Array<{ status: string }>;
    expect(items.map((i) => i.status)).toEqual(["complete", "blocked", "complete"]);
    expect(r.results.explore.status).toBe("error");
    expect(r.results.explore.summary).toMatch(/1 failed/);
    expect(r.results.merge.status).toBe("skipped");
  });
});

// ── 3. Loops, stale results, jumps ────────────────────────────────────────

describe("multi decision: loops and skipped results", () => {
  const LOOP = `name: loop
description: multi decision in a loop
steps:
  - id: plan
    type: code-decision
    multi: true
    branches:
      lane: lane
  - id: lane
    type: agent
    agent: worker
    task: "LANE"
  - id: again
    type: code-decision
    max_iterations: 3
    branches:
      more: plan
      done: end
  - id: end
    type: code
`;

  it("a stale pass-1 result is replaced by skipped when pass 2 chooses nothing", async () => {
    const t = tracker();
    const r = await runFauxFlow({
      flow: load(LOOP), agents: AGENTS,
      codeHandlers: {
        plan: `let n = 0; export default async () => { n++; return n === 1 ? { branches: ["lane"] } : { branches: [] }; };`,
        again: `let n = 0; export default async () => { n++; return { branch: n === 1 ? "more" : "done" }; };`,
        end: `export default async () => ({});`,
      },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    expect(t.count("lane")).toBe(1);
    expect(r.results.lane.status).toBe("skipped");
  });

  const SELF_LOOP = `name: selfloop
description: multi decision with a backward branch
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK"
  - id: route
    type: code-decision
    multi: true
    max_iterations: 1
    branches:
      retry: work
      docs: docs
  - id: docs
    type: agent
    agent: worker
    task: "LANE docs"
  - id: end
    type: code
`;

  it("a backward branch together with another route soft-fails naming both", async () => {
    const r = await runFauxFlow({
      flow: load(SELF_LOOP), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ branches: ["retry", "docs"] });`, end: `export default async () => ({});` },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("error");
    expect(r.lastResult.output).toMatch(/retry/);
    expect(r.lastResult.output).toMatch(/docs/);
  });

  it("a backward branch alone loops; at the cap the next segment is skipped and execution continues", async () => {
    const t = tracker();
    const r = await runFauxFlow({
      flow: load(SELF_LOOP), agents: AGENTS,
      codeHandlers: { route: `export default async () => ({ branches: ["retry"] });`, end: `export default async () => ({});` },
      responder: (x) => echo(x),
      onAgentStarted: t.onAgentStarted,
    });
    expect(r.status).toBe("success");
    expect(t.count("work")).toBe(2);
    expect(r.results.docs.status).toBe("skipped");
    expect(r.results.end.status).toBe("complete");
  });

  it("a jumped-over separator gets a skipped result", async () => {
    const yaml = `name: jump
description: optional e2e gate
steps:
  - id: want
    type: code-decision
    branches:
      run: e2e
      skip: report
  - id: e2e
    type: code-decision
    branches:
      pass: report
      fail: report
  - id: report
    type: code
    inputs:
      e2e: "\${{result.e2e.status}}"
    outputs:
      - name: seen
`;
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: {
        want: `export default async () => ({ branch: "skip" });`,
        e2e: `export default async () => ({ branch: "pass" });`,
        report: `export default async (input) => ({ seen: input.e2e });`,
      },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("success");
    expect(r.results.e2e.status).toBe("skipped");
    expect(r.results.report.outputs.seen).toBe("skipped");
  });
});

// ── 4. Classifiers ────────────────────────────────────────────────────────

describe("multi decision: classifiers never decide", () => {
  it("an inherited classifier chain is filtered to [agent]", async () => {
    const decisions: DecisionEvent[] = [];
    let classifierCalls = 0;
    const yaml = LANES(`  - id: route
    type: agent-decision
    agent: judge
    multi: true
    task: "DECIDE which lanes"
    branches:
      backend: backend
      frontend: frontend
      docs: docs`);
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      decider: ["system-one", "agent"] as any,
      entryOverrides: { "system-one": { decide: async () => { classifierCalls++; return { label: "docs", confidence: 1 }; } } as any },
      codeHandlers: { after: `export default async () => ({});` },
      responder: (x) => (/DECIDE/.test(x) ? ok("picked", { branches: ["backend"] }) : echo(x)),
      onDecision: (e) => decisions.push(e),
    });
    expect(r.status).toBe("success");
    expect(classifierCalls).toBe(0);
    expect(decisions[0].chain).toEqual(["agent"]);
  });
});

// ── 5. Validation ─────────────────────────────────────────────────────────

describe("multi decision: validation", () => {
  it("a one-branch multi decision is valid", () => {
    expect(errorsOf(FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`))).toEqual([]);
  });

  it("a forward target that is not an agent step in the next segment is rejected", () => {
    const yaml = LANES(`  - id: route
    type: code-decision
    multi: true
    branches:
      backend: backend
      tail: after`);
    const errs = errorsOf(yaml);
    expect(errs.some((m) => /route/.test(m) && /tail/.test(m) && /after/.test(m))).toBe(true);
  });

  it("a reserved output name on a multi code-decision is rejected", () => {
    const yaml = LANES(`${CODE_ROUTER}
    outputs:
      - name: routes`);
    expect(errorsOf(yaml).some((m) => /route/.test(m) && /routes/.test(m) && /reserved/i.test(m))).toBe(true);
  });

  it("${{item}} outside a fan-out target is rejected", () => {
    const yaml = LANES(CODE_ROUTER).replace('task: "LANE docs"', 'task: "LANE docs ${{item}}"');
    expect(errorsOf(yaml).some((m) => /docs/.test(m) && /item/.test(m))).toBe(true);
  });

  it("a declared output of a fan-out target referenced directly is rejected, .items is accepted", () => {
    const base = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"`).replace("agent: worker\n    task: \"EXPLORE", "agent: noter\n    task: \"EXPLORE");
    expect(errorsOf(base)).toEqual([]);
    const bad = base.replace('MERGE ${{result.explore.items}}', 'MERGE ${{result.explore.notes}}');
    expect(errorsOf(bad).some((m) => /explore/.test(m) && /\.items/.test(m))).toBe(true);
  });

  it("a step-level classifier decider on a multi decision is rejected", () => {
    const yaml = LANES(`  - id: route
    type: agent-decision
    agent: judge
    multi: true
    decider: [system-one, agent]
    task: "DECIDE"
    branches:
      backend: backend
      docs: docs`);
    expect(errorsOf(yaml).some((m) => /route/.test(m) && /classifier|system-one/i.test(m))).toBe(true);
  });

  it("two labels mapping to the same target are rejected", () => {
    const yaml = LANES(`  - id: route
    type: code-decision
    multi: true
    branches:
      a: backend
      b: backend`);
    expect(errorsOf(yaml).some((m) => /route/.test(m) && /backend/.test(m))).toBe(true);
  });

  it("a fan-out target reachable from another branch's target is rejected", () => {
    const yaml = `name: reach
description: fan-out target blocked by a lane
steps:
  - id: route
    type: code-decision
    multi: true
    branches:
      a: a
      b:
        to: b
        for_each: dynamic
  - id: a
    type: agent
    agent: worker
    task: "A"
  - id: b
    type: agent
    agent: worker
    blockedBy: [a]
    task: "B \${{item}}"
`;
    expect(errorsOf(yaml).some((m) => /\ba\b/.test(m) && /\bb\b/.test(m))).toBe(true);
  });

  it("max_items outside 1–1000 is rejected", () => {
    const yaml = FANOUT(`      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"
        max_items: 0`);
    expect(errorsOf(yaml).some((m) => /max_items/.test(m))).toBe(true);
  });

  it("a multi decision with nothing after it is rejected", () => {
    const yaml = `name: last
description: multi decision as the last step
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK"
  - id: route
    type: code-decision
    multi: true
    max_iterations: 2
    branches:
      retry: work
`;
    expect(errorsOf(yaml).some((m) => /route/.test(m) && /nothing follows/.test(m))).toBe(true);
  });
});

// ── 6. Events and display ─────────────────────────────────────────────────

import { EventEmitObserver, formatDecisionLine } from "../extensions/flow-engine/flow-tui.js";

describe("multi decision: events", () => {
  it("flow:decision of a fan-out carries labels and routes with the item count", async () => {
    const decisions: DecisionEvent[] = [];
    const yaml = `name: ev
description: agent multi decision with fan-out
steps:
  - id: scan
    type: code
    outputs:
      - name: projects
  - id: decide
    type: agent-decision
    agent: judge
    multi: true
    task: "DECIDE explore?"
    branches:
      explore:
        to: explore
        for_each: "\${{result.scan.projects}}"
      docs: docs
  - id: explore
    type: agent
    agent: worker
    task: "EXPLORE \${{item}}"
  - id: docs
    type: agent
    agent: worker
    task: "LANE docs"
  - id: end
    type: code
`;
    const r = await runFauxFlow({
      flow: load(yaml), agents: AGENTS,
      codeHandlers: { scan: `export default async () => ({ projects: ["a", "b"] });`, end: `export default async () => ({});` },
      responder: (x) => (/DECIDE/.test(x) ? ok("explore", { branches: ["explore"] }) : echo(x)),
      onDecision: (e) => decisions.push(e),
    });
    expect(r.status).toBe("success");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].labels).toEqual(["explore"]);
    expect(decisions[0].routes).toEqual([{ branch: "explore", itemCount: 2 }]);
    expect(decisions[0].routedBy).toBe("agent");
    expect(formatDecisionLine(decisions[0])).toBe("decided explore via agent");
    expect(formatDecisionLine({ ...decisions[0], labels: [], routes: [], label: undefined })).toBe("decided none via agent");
  });

  it("instance events carry stepId, itemIndex and itemCount on the flow:* channels", () => {
    const emitted: Array<[string, any]> = [];
    const obs = new EventEmitObserver({ events: { emit: (ch: string, d: any) => emitted.push([ch, d]) }, appendEntry: () => undefined } as any);
    const item = { index: 1, count: 3 };
    obs.onAssistantText("worker", "explore", "hi", item);
    obs.onThinkingText("worker", "explore", "hmm", item);
    obs.onToolCall("worker", "explore", "read", {}, item);
    obs.onToolResult("worker", "explore", "read", "x", false, item);
    obs.onAgentStarted("worker", "explore", undefined, undefined, { nodeKind: "agent", itemIndex: 1, itemCount: 3 });
    const byCh = new Map(emitted.map(([c, d]) => [c, d]));
    for (const ch of ["flow:assistant-text", "flow:thinking-text", "flow:subagent-tool-call", "flow:subagent-tool-result", "flow:agent-started"]) {
      expect(byCh.get(ch), ch).toMatchObject({ stepId: "explore", itemIndex: 1, itemCount: 3 });
    }
    obs.onAssistantText("worker", "plain", "hi");
    expect(emitted[emitted.length - 1][1].itemIndex).toBeUndefined();
  });
});

// ── 7. Handler scaffold ───────────────────────────────────────────────────

import { renderScaffold } from "../extensions/flow-engine/flow-generate.js";

describe("multi decision: handler scaffold", () => {
  it("types a multi code-decision's return as { branch } | { branches } | { routes }", () => {
    const flow = parseFlowYamlString(LANES(CODE_ROUTER), "<multi>");
    const out = renderScaffold(flow.steps[0] as never);
    expect(out).toMatch(/\{ branch: Branch \}/);
    expect(out).toMatch(/\{ branches: Branch\[\] \}/);
    expect(out).toMatch(/\{ routes: Array<\{ branch: Branch; items\?: unknown\[\] \}> \}/);
  });

  it("keeps { branch: Branch } & Output for a single code-decision", () => {
    const flow = parseFlowYamlString(LANES(CODE_ROUTER).replace("    multi: true\n", ""), "<multi>");
    expect(renderScaffold(flow.steps[0] as never)).toMatch(/Promise<\{ branch: Branch \} & Output>/);
  });
});

// ── 8. Reserved `branches` on decision agents ─────────────────────────────

describe("multi decision: reserved branches output", () => {
  const brancher = parseAgentString(agentMd("brancher", ["branches"]), "<multi>");
  const withBrancher = [...AGENTS, brancher];
  const byName = new Map(withBrancher.map((a) => [a.name, a]));
  const flowWith = (multi: boolean) => LANES(`  - id: route
    type: agent-decision
    agent: brancher
${multi ? "    multi: true\n" : ""}    task: "DECIDE which lanes"
    branches:
      backend: backend
      frontend: frontend
      docs: docs`);

  it("a multi decision's agent declaring a `branches` output is rejected (validation and run start)", async () => {
    const errs = validateFlowContent(flowWith(true), () => byName as never, () => true).diagnostics.filter((d) => d.severity === "error");
    expect(errs.some((d) => /brancher/.test(d.message) && /branches/.test(d.message))).toBe(true);
    const r = await runFauxFlow({
      flow: parseFlowYamlString(flowWith(true), "<multi>"), agents: withBrancher,
      codeHandlers: { after: `export default async () => ({});` },
      responder: (x) => echo(x),
    });
    expect(r.status).toBe("error");
    expect(r.lastResult.output).toMatch(/not started.*branches/);
  });

  it("a single decision's agent may still declare a `branches` output", () => {
    const errs = validateFlowContent(flowWith(false), () => byName as never, () => true).diagnostics.filter((d) => d.severity === "error");
    expect(errs.filter((d) => /branches/.test(d.message))).toEqual([]);
  });
});
