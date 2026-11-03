/**
 * Realistic end-to-end faux flows (part 2 of 2). Same approach as part 1:
 * authored flow.yaml + markdown agents + co-located `<id>.ts` handlers in a
 * temp flow dir → validated → parsed → run on the real runFlow via runFaux.
 * Responders route on the dispatched task text, never on call order.
 *
 *    7. release: changelog → tests (code) → autonomous fork (decision_agent) → tag | hold → announce
 *    8. dependency upgrade driven by typed flow inputs (required / optional / type checks)
 *    9. draft-and-test: two independent loops in sequence
 *   10. change request: a forward code-decision branch skips design + spec
 *   11. deploy pipeline with on_error rescue (agent soft-fail, code throw, FlowHardError)
 *   12. model-mixed agents: role lists, omitted model, literal model, role-only
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runFaux, scriptFinish, type FauxResponseStep } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { AgentConfig, DecisionEvent, FlowConfig } from "../extensions/flow-engine/types.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- authoring helpers (same shape as part 1) --------------------------------

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

const errorsOf = <T extends { severity: string }>(d: T[]) => d.filter((x) => x.severity === "error");
function author(yaml: string, agentMds: string[], handlers: Record<string, string> = {}): { flow: FlowConfig; agents: AgentConfig[] } {
  const dir = mkdtempSync(join(tmpdir(), "e2e-realistic2-"));
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
const task = (fn: (t: string, model: any) => FauxResponseStep) => (raw: string, model: any) => fn(raw.replace(/^Task: /, ""), model);
const ok = (summary: string, extra: Record<string, unknown> = {}) => scriptFinish({ status: "complete", summary, ...extra });

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
    steps: () => started.map((s) => s.step),
    count: (step: string) => started.filter((s) => s.step === step).length,
  };
}

// ---- 7. release: autonomous fork decided by the flow's decision_agent --------

const RELEASE_YAML = `name: release
description: write the changelog, run the test suite, let the release captain decide, then tag
decision_agent: release-captain
steps:
  - id: changelog
    type: agent
    agent: changelog-writer
    task: "CHANGELOG since the last tag for \${{task}}"
  - id: run-tests
    type: code
    blockedBy: [changelog]
    inputs:
      version: "\${{result.changelog.version}}"
    outputs:
      - name: passed
      - name: total
      - name: failed
  - id: go-no-go
    type: fork
    blockedBy: [run-tests]
    question: "Release \${{result.changelog.version}}?"
    task: "GO-NO-GO for \${{result.changelog.version}}: \${{result.run-tests.total}} tests, \${{result.run-tests.failed}} failed (passed=\${{result.run-tests.passed}})"
    options: [ship, hold]
    branches:
      ship: tag
      hold: hold-notice
  - id: tag
    type: agent
    agent: release-engineer
    blockedBy: [run-tests]
    task: "TAG v\${{result.changelog.version}} with notes: \${{result.changelog.notes}}"
  - id: hold-notice
    type: agent
    agent: release-engineer
    blockedBy: [run-tests]
    task: "HOLD-NOTICE: v\${{result.changelog.version}} held, \${{result.run-tests.failed}} failing tests"
  - id: announce
    type: agent
    agent: announcer
    blockedBy: [tag, hold-notice]
    task: "ANNOUNCE tag=[\${{result.tag.tag_name}}] hold=[\${{result.hold-notice.summary}}]"
`;

const RUN_TESTS_TS = `export default async function runTests(input, ctx) {
  const failed = String(input.version).includes("rc") ? 2 : 0;
  ctx.setSummary("ran 128 tests for " + input.version);
  return { passed: failed === 0, total: 128, failed };
}
`;

describe("e2e realistic 7: release with an autonomous go/no-go fork", () => {
  const run = async (version: string) => {
    const { flow, agents } = author(RELEASE_YAML, [
      agentMd("changelog-writer", { outputs: ["version", "notes"] }),
      agentMd("release-captain", { desc: "decides whether a release ships" }),
      agentMd("release-engineer", { outputs: ["tag_name"] }),
      agentMd("announcer"),
    ], { "run-tests": RUN_TESTS_TS });
    const o = observe();
    let asked = 0;
    const result = await runFaux({
      flow, agents, task: "pi-flows", isAutonomous: () => true,
      askUser: async () => { asked++; return { answer: "hold" }; },
      responder: task((t) => {
        if (t.startsWith("CHANGELOG")) { o.record("changelog", t); return ok("changelog drafted", { version, notes: "faster fan-in; new release flow" }); }
        if (t.startsWith("GO-NO-GO")) { o.record("captain", t); return ok("decided", { branch: /passed=true/.test(t) ? "ship" : "hold" }); }
        if (t.startsWith("TAG")) { o.record("tag", t); return ok("tagged", { tag_name: `v${version}` }); }
        if (t.startsWith("HOLD-NOTICE")) { o.record("hold", t); return ok("release held", { tag_name: "" }); }
        if (t.startsWith("ANNOUNCE")) { o.record("announce", t); return ok("announced"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onAgentComplete: o.onAgentComplete, onDecision: o.onDecision,
    });
    return { result, o, asked: () => asked };
  };

  it("green tests: the captain ships and the tag is announced; the user is never asked", async () => {
    const { result, o, asked } = await run("1.4.0");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(asked()).toBe(0);
    expect(result.results["run-tests"].outputs).toEqual({ passed: true, total: 128, failed: 0 });
    expect(result.results["run-tests"].summary).toBe("ran 128 tests for 1.4.0");

    // The flow-level decision_agent decided the fork and saw the expanded fork task + options.
    expect(o.started.filter((s) => s.step === "go-no-go").map((s) => s.name)).toContain("release-captain");
    expect(o.tasks.captain).toHaveLength(1);
    expect(o.tasks.captain[0]).toContain("GO-NO-GO for 1.4.0: 128 tests, 0 failed (passed=true)");
    expect(o.tasks.captain[0]).toContain("- ship");
    expect(o.tasks.captain[0]).toContain("- hold");
    expect(o.decisions.map((d) => [d.stepId, d.label, d.routedBy])).toEqual([["go-no-go", "ship", "agent"]]);
    expect(result.forks["go-no-go"].answer).toBe("ship");

    expect(o.tasks.tag).toEqual(["TAG v1.4.0 with notes: faster fan-in; new release flow"]);
    expect(o.tasks.hold).toBeUndefined();
    expect(result.results["hold-notice"].status).toBe("skipped");
    expect(o.tasks.announce).toEqual(["ANNOUNCE tag=[v1.4.0] hold=[]"]);
    expect(o.log.indexOf("start:announce")).toBeGreaterThan(o.log.indexOf("end:tag"));
  });

  it("failing tests on an RC: the captain holds; tag never runs", async () => {
    const { result, o, asked } = await run("1.5.0-rc.1");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(asked()).toBe(0);
    expect(o.tasks.captain[0]).toContain("2 failed (passed=false)");
    expect(result.forks["go-no-go"].answer).toBe("hold");
    expect(o.tasks.hold).toEqual(["HOLD-NOTICE: v1.5.0-rc.1 held, 2 failing tests"]);
    expect(o.tasks.tag).toBeUndefined();
    expect(result.results.tag.status).toBe("skipped");
    expect(o.tasks.announce).toEqual(["ANNOUNCE tag=[] hold=[release held]"]);
  });
});

// ---- 8. typed flow inputs ----------------------------------------------------

const UPGRADE_YAML = `name: dependency-upgrade
description: upgrade dependencies in a repository, optionally opening a PR
inputs:
  repo: { type: string, required: true }
  branch: { type: string }
  max_packages: { type: number }
  ignore: { type: array }
  dry_run: { type: boolean, required: true }
steps:
  - id: scope
    type: code
    inputs:
      repo: "\${{flow.input.repo}}"
      max_packages: "\${{flow.input.max_packages}}"
      ignore: "\${{flow.input.ignore}}"
    outputs:
      - name: limit
      - name: ignored
      - name: types
  - id: scan
    type: agent
    agent: scanner
    blockedBy: [scope]
    task: "SCAN \${{flow.input.repo}}@\${{flow.input.branch}} for outdated deps (limit \${{result.scope.limit}}, ignoring \${{flow.input.ignore}})"
  - id: upgrade
    type: agent
    agent: upgrader
    blockedBy: [scan]
    task: "UPGRADE in \${{flow.input.repo}}: \${{result.scan.summary}}"
  - id: mode
    type: code-decision
    blockedBy: [upgrade]
    inputs:
      dry_run: "\${{flow.input.dry_run}}"
    branches:
      dry: report
      live: open-pr
  - id: open-pr
    type: agent
    agent: upgrader
    task: "OPEN-PR against \${{flow.input.repo}} branch \${{flow.input.branch}}"
  - id: report
    type: agent
    agent: reporter
    blockedBy: [open-pr]
    task: "REPORT dry_run=\${{flow.input.dry_run}} pr=[\${{result.open-pr.summary}}]"
`;

// Defaults live in the handler: an absent optional input arrives as "".
const SCOPE_TS = `export default async function scope(input) {
  const kind = (v) => (Array.isArray(v) ? "array" : typeof v);
  return {
    limit: typeof input.max_packages === "number" ? input.max_packages : 20,
    ignored: Array.isArray(input.ignore) ? input.ignore.length : 0,
    types: [input.repo, input.max_packages, input.ignore].map(kind).join("/"),
  };
}
`;
const MODE_TS = `export default async function mode(input) {
  if (typeof input.dry_run !== "boolean") throw new Error("dry_run must be a boolean");
  return { branch: input.dry_run ? "dry" : "live" };
}
`;

describe("e2e realistic 8: dependency upgrade driven by typed flow inputs", () => {
  const AGENTS = [agentMd("scanner"), agentMd("upgrader"), agentMd("reporter")];
  const run = async (flowInput: Record<string, unknown>) => {
    const { flow, agents } = author(UPGRADE_YAML, AGENTS, { scope: SCOPE_TS, mode: MODE_TS });
    const o = observe();
    let spawns = 0;
    const result = await runFaux({
      flow, agents, flowInput,
      responder: task((t) => {
        spawns++;
        if (t.startsWith("SCAN")) { o.record("scan", t); return ok("3 outdated: vitest, yaml, typebox"); }
        if (t.startsWith("UPGRADE")) { o.record("upgrade", t); return ok("upgraded 3 packages"); }
        if (t.startsWith("OPEN-PR")) { o.record("open-pr", t); return ok("PR #7 opened"); }
        if (t.startsWith("REPORT")) { o.record("report", t); return ok("reported"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted,
    });
    return { result, o, spawns: () => spawns };
  };

  it("all inputs provided: typed values reach the handlers, JSON text reaches the agents", async () => {
    const { result, o } = await run({ repo: "acme/api", branch: "develop", max_packages: 5, ignore: ["react"], dry_run: false });
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.scope.outputs).toEqual({ limit: 5, ignored: 1, types: "string/number/array" });
    expect(o.tasks.scan).toEqual(['SCAN acme/api@develop for outdated deps (limit 5, ignoring ["react"])']);
    expect(o.tasks.upgrade).toEqual(["UPGRADE in acme/api: 3 outdated: vitest, yaml, typebox"]);
    expect(o.tasks["open-pr"]).toEqual(["OPEN-PR against acme/api branch develop"]);
    expect(o.tasks.report).toEqual(["REPORT dry_run=false pr=[PR #7 opened]"]);
  });

  it("optional inputs omitted: references expand to empty, the handler applies its default, dry run skips the PR", async () => {
    const { result, o } = await run({ repo: "acme/api", dry_run: true });
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.scope.outputs).toEqual({ limit: 20, ignored: 0, types: "string/string/string" });
    expect(o.tasks.scan).toEqual(["SCAN acme/api@ for outdated deps (limit 20, ignoring )"]);
    expect(o.tasks["open-pr"]).toBeUndefined();
    expect(result.results["open-pr"].status).toBe("skipped");
    expect(o.tasks.report).toEqual(["REPORT dry_run=true pr=[]"]);
    for (const t of Object.values(o.tasks).flat()) expect(t).not.toContain("undefined");
  });

  it("a missing required input refuses to start: nothing runs", async () => {
    const { result, o, spawns } = await run({ dry_run: true });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toMatch(/missing required input "repo"/);
    expect(spawns()).toBe(0);
    expect(o.started).toEqual([]);
    expect(result.results).toEqual({});
  });

  it("a type mismatch refuses to start", async () => {
    const { result, spawns } = await run({ repo: "acme/api", dry_run: true, max_packages: "five" });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toMatch(/input "max_packages" expected number, got string/);
    expect(spawns()).toBe(0);
  });

  it("a flow using ${{flow.input.*}} references validates without errors", () => {
    const diag = validateFlowContent(UPGRADE_YAML, () => new Map(AGENTS.map((m) => { const a = parseAgentString(m, "<t>"); return [a.name, a]; })), () => true);
    expect(errorsOf(diag.diagnostics)).toEqual([]);
  });

  it("an input schema with an unknown type is a validation error", () => {
    const bad = UPGRADE_YAML.replace("max_packages: { type: number }", "max_packages: { type: integer }");
    const diag = validateFlowContent(bad, () => new Map(), () => true);
    expect(errorsOf(diag.diagnostics).map((d) => d.message).join("\n")).toMatch(/max_packages/);
  });
});

// ---- 9. two independent loops in sequence -----------------------------------

const DRAFT_TEST_YAML = `name: draft-and-test
description: polish a draft until it is good enough (loop a), then harden flaky tests (loop b)
decision_agent: qa-lead
steps:
  - id: draft
    type: agent
    agent: author
    task: "DRAFT pass \${{loop.a.iteration}}/\${{loop.a.max}} of \${{task}}"
  - id: a
    type: code-decision
    blockedBy: [draft]
    inputs:
      quality: "\${{result.draft.quality}}"
    branches:
      polish: draft
      ready: test
    max_iterations: 2
  - id: test
    type: agent
    agent: tester
    task: "TEST pass \${{loop.b.iteration}}/\${{loop.b.max}} (draft loop cap \${{loop.a.max}})"
  - id: b
    type: agent-decision
    task: "B-GATE pass \${{loop.b.iteration}}/\${{loop.b.max}}: are the tests stable?"
    state:
      flaky: "\${{result.test.flaky}}"
    branches:
      retry: { to: test, means: "Some tests are still flaky" }
      stable: { to: ship, means: "No flaky tests remain" }
    max_iterations: 3
  - id: ship
    type: agent
    agent: author
    task: "SHIP with \${{result.test.summary}} and draft quality \${{result.draft.quality}}"
`;

const A_TS = `export default async function a(input) {
  return { branch: input.quality >= 80 ? "ready" : "polish" };
}
`;

describe("e2e realistic 9: two independent loops in sequence", () => {
  it("loop a and loop b keep separate iteration counters and caps", async () => {
    const { flow, agents } = author(DRAFT_TEST_YAML, [
      agentMd("author", { outputs: ["quality:number"] }),
      agentMd("tester", { outputs: ["flaky:number"] }),
      agentMd("qa-lead"),
    ], { a: A_TS });
    const o = observe();
    const result = await runFaux({
      flow, agents, task: "the onboarding guide", maxTurns: 48,
      responder: task((t) => {
        if (t.startsWith("DRAFT")) { o.record("draft", t); const pass = Number(/pass (\d+)/.exec(t)?.[1]); return ok(`draft ${pass}`, { quality: pass * 40 }); }
        if (t.startsWith("TEST")) { o.record("test", t); const pass = Number(/pass (\d+)/.exec(t)?.[1]); return ok(`${3 - pass} flaky`, { flaky: 3 - pass }); }
        if (t.startsWith("B-GATE")) { o.record("gate", t); return ok("judged", { branch: /- flaky: 0\b/.test(t) ? "stable" : "retry" }); }
        if (t.startsWith("SHIP")) { o.record("ship", t); return ok("shipped", { quality: 100 }); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted, onDecision: o.onDecision,
    });

    expect(result.status, result.lastResult.result.summary).toBe("success");
    // Loop a: two passes, counter 1..2 of cap 2.
    expect(o.tasks.draft).toEqual(["DRAFT pass 1/2 of the onboarding guide", "DRAFT pass 2/2 of the onboarding guide"]);
    // Loop b starts its own counter at 1 and knows loop a's cap independently.
    expect(o.tasks.test).toEqual([
      "TEST pass 1/3 (draft loop cap 2)",
      "TEST pass 2/3 (draft loop cap 2)",
      "TEST pass 3/3 (draft loop cap 2)",
    ]);
    expect(o.tasks.gate.map((g) => /B-GATE pass \d\/\d/.exec(g)?.[0])).toEqual(["B-GATE pass 1/3", "B-GATE pass 2/3", "B-GATE pass 3/3"]);
    expect(o.tasks.gate[0]).toContain("- flaky: 2");
    expect(o.tasks.gate[2]).toContain("- flaky: 0");
    expect(o.decisions.filter((d) => d.stepId === "b").map((d) => d.label)).toEqual(["retry", "retry", "stable"]);
    // The decision agent came from the flow-level decision_agent.
    expect(new Set(o.started.filter((s) => s.step === "b").map((s) => s.name))).toEqual(new Set(["qa-lead"]));
    expect(o.tasks.ship).toEqual(["SHIP with 0 flaky and draft quality 80"]);
    expect(o.count("draft")).toBe(2);
    expect(o.count("test")).toBe(3);
  });
});

// ---- 10. forward branch skipping steps ---------------------------------------

const CHANGE_YAML = `name: change-request
description: size a change request; small ones skip design and spec and go straight to implementation
steps:
  - id: intake
    type: agent
    agent: analyst
    task: "INTAKE \${{task}}"
  - id: sizing
    type: code-decision
    blockedBy: [intake]
    inputs:
      points: "\${{result.intake.points}}"
    outputs:
      - name: size
    branches:
      small: implement
      large: design
  - id: design
    type: agent
    agent: architect
    blockedBy: [sizing]
    task: "DESIGN for \${{result.intake.summary}}"
  - id: spec
    type: agent
    agent: architect
    blockedBy: [design]
    task: "SPEC from \${{result.design.summary}}"
  - id: implement
    type: agent
    agent: developer
    blockedBy: [spec]
    task: "IMPLEMENT \${{result.sizing.size}} change; design=[\${{result.design.summary}}] acceptance=[\${{result.spec.acceptance}}] spec-status=[\${{result.spec.status}}]"
  - id: summary
    type: agent
    agent: analyst
    blockedBy: [implement]
    task: "SUMMARY design-status=\${{result.design.status}} implement=\${{result.implement.summary}}"
`;

const SIZING_TS = `export default async function sizing(input) {
  if (typeof input.points !== "number") throw new Error("points must be a number");
  return input.points <= 3 ? { branch: "small", size: "S" } : { branch: "large", size: "L" };
}
`;

describe("e2e realistic 10: a forward branch skips design and spec", () => {
  const run = async (request: string) => {
    const { flow, agents } = author(CHANGE_YAML, [
      agentMd("analyst", { outputs: ["points:number"] }),
      agentMd("architect", { outputs: ["acceptance"] }),
      agentMd("developer"),
    ], { sizing: SIZING_TS });
    const o = observe();
    const result = await runFaux({
      flow, agents, task: request,
      responder: task((t) => {
        if (t.startsWith("INTAKE")) { o.record("intake", t); return ok(`request: ${request}`, { points: /typo/.test(t) ? 1 : 8 }); }
        if (t.startsWith("DESIGN")) { o.record("design", t); return ok("event-sourced audit log", { acceptance: "n/a" }); }
        if (t.startsWith("SPEC")) { o.record("spec", t); return ok("spec written", { acceptance: "every write is audited" }); }
        if (t.startsWith("IMPLEMENT")) { o.record("implement", t); return ok("implemented"); }
        if (t.startsWith("SUMMARY")) { o.record("summary", t); return ok("summarized", { points: 0 }); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted,
    });
    return { result, o };
  };

  it("small change: design and spec are skipped; references to them expand to empty", async () => {
    const { result, o } = await run("fix a typo in the settings page");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.sizing.outputs.size).toBe("S");
    expect(o.steps().filter((s) => s !== "sizing")).toEqual(["intake", "implement", "summary"]);
    expect(o.tasks.design).toBeUndefined();
    expect(o.tasks.spec).toBeUndefined();
    expect(result.results.design.status).toBe("skipped");
    expect(result.results.spec.status).toBe("skipped");
    expect(o.tasks.implement).toEqual(["IMPLEMENT S change; design=[] acceptance=[] spec-status=[skipped]"]);
    expect(o.tasks.summary).toEqual(["SUMMARY design-status=skipped implement=implemented"]);
  });

  it("large change: the full design → spec → implement path runs", async () => {
    const { result, o } = await run("add an audit log for all writes");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(o.steps().filter((s) => s !== "sizing")).toEqual(["intake", "design", "spec", "implement", "summary"]);
    expect(o.tasks.design).toEqual(["DESIGN for request: add an audit log for all writes"]);
    expect(o.tasks.spec).toEqual(["SPEC from event-sourced audit log"]);
    expect(o.tasks.implement).toEqual(["IMPLEMENT L change; design=[event-sourced audit log] acceptance=[every write is audited] spec-status=[complete]"]);
    expect(o.tasks.summary).toEqual(["SUMMARY design-status=complete implement=implemented"]);
  });
});

// ---- 11. deploy pipeline with on_error rescue -------------------------------

const DEPLOY_YAML = `name: deploy
description: build, migrate, deploy and smoke-test; any recoverable failure rolls back
inputs:
  env: { type: string, required: true }
steps:
  - id: build
    type: code
    inputs:
      env: "\${{flow.input.env}}"
    outputs:
      - name: artifact
    on_error: rollback
  - id: migrate
    type: agent
    agent: db-migrator
    blockedBy: [build]
    task: "MIGRATE the \${{flow.input.env}} database for \${{result.build.artifact}}"
    on_error: rollback
  - id: deploy
    type: agent
    agent: deployer
    blockedBy: [migrate]
    task: "DEPLOY \${{result.build.artifact}} to \${{flow.input.env}}"
    on_error: rollback
  - id: smoke
    type: code-decision
    blockedBy: [deploy]
    inputs:
      url: "\${{result.deploy.url}}"
    outputs:
      - name: checks
    branches:
      healthy: announce
      unhealthy: rollback
    on_error: rollback
  - id: announce
    type: agent
    agent: announcer
    task: "ANNOUNCE \${{result.build.artifact}} live at \${{result.deploy.url}} (\${{result.smoke.checks}} checks green)"
  - id: rollback
    type: agent
    agent: deployer
    task: "ROLLBACK \${{flow.input.env}}: migrate=\${{result.migrate.status}} deploy=\${{result.deploy.status}} smoke=\${{result.smoke.status}} reason=[\${{result.migrate.summary}}]"
  - id: incident
    type: agent
    agent: announcer
    blockedBy: [rollback]
    task: "INCIDENT report: \${{result.rollback.summary}}"
`;

const BUILD_TS = `import { FlowHardError } from ${JSON.stringify(join(REPO, "extensions/flow-engine/types.ts"))};
export default async function build(input) {
  if (input.env === "prod-frozen") throw new FlowHardError("deploy freeze in effect for prod");
  return { artifact: "app-" + input.env + "-1.2.3.tgz" };
}
`;
const SMOKE_TS = `export default async function smoke(input) {
  if (input.url.includes("unreachable")) throw new Error("health endpoint unreachable: " + input.url);
  if (input.url.includes("degraded")) return { branch: "unhealthy", checks: 1 };
  return { branch: "healthy", checks: 3 };
}
`;

describe("e2e realistic 11: deploy pipeline with on_error rescue", () => {
  const run = async (env: string) => {
    const { flow, agents } = author(DEPLOY_YAML, [
      agentMd("db-migrator"), agentMd("deployer", { outputs: ["url"] }), agentMd("announcer"),
    ], { build: BUILD_TS, smoke: SMOKE_TS });
    const o = observe();
    let spawns = 0;
    const result = await runFaux({
      flow, agents, flowInput: { env },
      responder: task((t) => {
        spawns++;
        if (t.startsWith("MIGRATE")) {
          o.record("migrate", t);
          return env === "prod-db-locked"
            ? scriptFinish({ status: "error", summary: "lock timeout on users table" })
            : ok("2 migrations applied");
        }
        if (t.startsWith("DEPLOY")) { o.record("deploy", t); return ok("deployed", { url: `https://${env}.acme.dev` }); }
        if (t.startsWith("ANNOUNCE")) { o.record("announce", t); return ok("announced"); }
        if (t.startsWith("ROLLBACK")) { o.record("rollback", t); return ok("rolled back", { url: "" }); }
        if (t.startsWith("INCIDENT")) { o.record("incident", t); return ok("incident filed"); }
        return ok("unexpected");
      }),
      onAgentStarted: o.onAgentStarted,
    });
    return { result, o, spawns: () => spawns };
  };

  it("happy path: smoke is healthy, announce runs, rollback and incident are skipped", async () => {
    const { result, o } = await run("staging");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(o.tasks.migrate).toEqual(["MIGRATE the staging database for app-staging-1.2.3.tgz"]);
    expect(o.tasks.deploy).toEqual(["DEPLOY app-staging-1.2.3.tgz to staging"]);
    expect(result.results.smoke.outputs.checks).toBe(3);
    expect(o.tasks.announce).toEqual(["ANNOUNCE app-staging-1.2.3.tgz live at https://staging.acme.dev (3 checks green)"]);
    expect(o.tasks.rollback).toBeUndefined();
    expect(result.results.rollback.status).toBe("skipped");
    expect(result.results.incident.status).toBe("skipped");
  });

  it("migration soft-fails (finish status error): on_error rescues to rollback; deploy and smoke never run", async () => {
    const { result, o } = await run("prod-db-locked");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.migrate.status).toBe("error");
    expect(o.tasks.deploy).toBeUndefined();
    expect(result.results.deploy.status).toBe("skipped");
    expect(result.results.smoke).toBeUndefined();
    expect(o.tasks.rollback).toEqual(["ROLLBACK prod-db-locked: migrate=error deploy=skipped smoke= reason=[lock timeout on users table]"]);
    expect(o.tasks.incident).toEqual(["INCIDENT report: rolled back"]);
    expect(o.tasks.announce).toBeUndefined();
  });

  it("a degraded smoke test routes to rollback via its branch", async () => {
    const { result, o } = await run("prod-degraded");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.smoke.outputs.checks).toBe(1);
    expect(o.tasks.rollback).toEqual(["ROLLBACK prod-degraded: migrate=complete deploy=complete smoke=complete reason=[2 migrations applied]"]);
    expect(o.tasks.announce).toBeUndefined();
    expect(o.tasks.incident).toHaveLength(1);
  });

  it("a throwing smoke handler soft-fails and is rescued by on_error", async () => {
    // docs/flows.md → Code Decision Step: any code-step failure is soft and routes to on_error.
    const { result, o } = await run("prod-unreachable");
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(result.results.smoke.status).not.toBe("complete");
    expect(result.results.smoke.summary).toContain("health endpoint unreachable");
    expect(o.tasks.rollback).toHaveLength(1);
    expect(o.tasks.rollback[0]).toMatch(/^ROLLBACK prod-unreachable: migrate=complete deploy=complete smoke=error /);
    expect(o.tasks.announce).toBeUndefined();
    expect(o.tasks.incident).toEqual(["INCIDENT report: rolled back"]);
  });

  it("FlowHardError in build ignores on_error and halts before any agent spawns", async () => {
    const { result, o, spawns } = await run("prod-frozen");
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toContain("deploy freeze in effect for prod");
    expect(spawns()).toBe(0);
    expect(o.tasks.rollback).toBeUndefined();
    expect(result.results.rollback).toBeUndefined();
  });
});

// ---- 12. model-mixed agents ---------------------------------------------------

const MODEL_YAML = `name: model-mix
description: plan, code, review and document with agents on different model declarations
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN \${{task}}"
  - id: code
    type: agent
    agent: coder
    blockedBy: [plan]
    task: "CODE \${{result.plan.summary}}"
  - id: review
    type: agent
    agent: reviewer
    blockedBy: [code]
    task: "REVIEW \${{result.code.summary}}"
  - id: gate
    type: agent-decision
    agent: judge
    task: "GATE: \${{result.review.summary}}"
    branches:
      done: docs
      redo: code
    max_iterations: 1
  - id: docs
    type: agent
    agent: scribe
    task: "DOCS for \${{result.code.summary}}"
`;

const MODEL_AGENTS = [
  agentMd("planner", { model: "[@unassigned-role, faux/faux-1]" }),
  agentMd("coder", { model: null }),
  agentMd("reviewer", { model: "faux/faux-1" }),
  agentMd("judge", { model: "@fast" }),
  agentMd("scribe", { model: "[@writing, @docs]" }),
];

/** A handler-supplied Model object (not in the session registry). */
const fauxModel = (id: string) => ({
  id, name: id, api: "faux", provider: "faux", baseUrl: "http://faux.invalid", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
});

describe("e2e realistic 12: agents with mixed model declarations", () => {
  const run = async (opts: { resolveHandler?: (probe: any) => void; modelFallback?: "session" | "error" } = {}) => {
    const { flow, agents } = author(MODEL_YAML, MODEL_AGENTS);
    const o = observe();
    const served: Array<[string, string]> = [];
    const result = await runFaux({
      flow, agents, task: "a CSV exporter", ...opts,
      responder: task((t, model) => {
        const marker = /^[A-Z]+/.exec(t)?.[0] ?? "?";
        served.push([marker, model?.id]);
        if (marker === "GATE") return ok("judged", { branch: "done" });
        return ok(`${marker.toLowerCase()} done`);
      }),
      onAgentStarted: o.onAgentStarted, onDecision: o.onDecision,
    });
    const by = (step: string) => o.started.find((s) => s.step === step)!;
    return { result, o, served, by };
  };

  it("no resolver: role lists skip to the literal, omitted/role-only models fall back to the session model", async () => {
    const { result, served, by } = await run();
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(served.map(([m]) => m)).toEqual(["PLAN", "CODE", "REVIEW", "GATE", "DOCS"]);
    for (const [, id] of served) expect(id).toBe("faux-1");

    // [@unassigned-role, faux/faux-1]: the role is skipped, the literal resolves → no fallback.
    expect(by("plan").model).toBe("faux/faux-1");
    expect(by("plan").extra?.modelFallback).toBeUndefined();
    // omitted model → session model.
    expect(by("code").extra.modelFallback).toEqual({ requested: [], used: "faux/faux-1", reason: "no-model-declared" });
    // literal model → no fallback.
    expect(by("review").model).toBe("faux/faux-1");
    expect(by("review").extra?.modelFallback).toBeUndefined();
    // role-only refs with no resolver → session model, reported.
    expect(by("gate").extra.modelFallback).toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "no-resolver" });
    expect(by("docs").extra.modelFallback).toEqual({ requested: ["@writing", "@docs"], used: "faux/faux-1", reason: "no-resolver" });
  });

  it("with a resolver: @fast resolves to its own model, unassigned roles report resolver-error", async () => {
    const probes: string[] = [];
    const { result, served, by } = await run({
      resolveHandler: (probe) => {
        probes.push(probe.ref);
        if (probe.ref === "@fast") { probe.model = fauxModel("faux-fast"); probe.resolved = "faux/faux-fast"; } else if (probe.ref.startsWith("@")) probe.error = `Role "${probe.ref}" is not assigned`;
      },
    });
    expect(result.status, result.lastResult.result.summary).toBe("success");
    expect(Object.fromEntries(served)).toEqual({ PLAN: "faux-1", CODE: "faux-1", REVIEW: "faux-1", GATE: "faux-fast", DOCS: "faux-1" });
    expect(by("plan").extra?.modelFallback).toBeUndefined();
    expect(by("gate").model).toBe("faux/faux-fast");
    expect(by("gate").extra?.modelFallback).toBeUndefined();
    expect(by("docs").extra.modelFallback).toEqual({ requested: ["@writing", "@docs"], used: "faux/faux-1", reason: "resolver-error" });
    expect(by("code").extra.modelFallback.reason).toBe("no-model-declared");
    expect(probes).toEqual(expect.arrayContaining(["@unassigned-role", "@fast", "@writing", "@docs"]));
  });

  it("strict mode (modelFallback: error): an agent without a resolvable model fails instead of falling back", async () => {
    const { result, served } = await run({ modelFallback: "error" });
    expect(result.status).toBe("error");
    // plan resolves via its literal; coder (no model:) has nothing to fall back to and halts the run.
    expect(served).toEqual([["PLAN", "faux-1"]]);
    expect(result.results.plan.status).toBe("complete");
    expect(result.results.code.status).toBe("error");
    expect(result.lastResult.result.summary).toMatch(/agent "coder".*no model declared.*modelFallback is "error"/);
    expect(result.results.review).toBeUndefined();
    expect(result.results.docs).toBeUndefined();
  });
});
