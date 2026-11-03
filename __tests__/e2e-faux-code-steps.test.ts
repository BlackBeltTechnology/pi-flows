/**
 * End-to-end faux scenarios for `code` steps: input wiring (task, flow inputs,
 * agent summary / reply text / typed outputs), typed vs. serialized delivery,
 * code outputs consumed downstream, the return contract, failure routing,
 * fan-out → code aggregation, skipped-branch reads, and reserved output names.
 *
 * Written from the documented behaviour (docs/flows.md "Code Step",
 * "Failure Modes", "Template Variable Reference", "Routing Node Semantics";
 * docs/flow-authoring.md "Typed data between steps"). Flows/agents are
 * authored as YAML/markdown, validated, parsed, and run on the real runFlow
 * with the faux provider. Handlers are supplied via runFauxFlow's
 * `codeHandlers` (temp .mjs wired into `target:`), or — for the vote fixture —
 * co-located `<id>.ts` beside `flow.yaml` (the convention path).
 *
 * Code-decision routing, loops and the larger realistic loops live in
 * e2e-faux-code-steps-2.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runFaux, runFauxFlow, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";

// ── helpers ───────────────────────────────────────────────────────────────

type OutSpec = string | { name: string; type: string };

const agentMd = (name: string, outputs: OutSpec[] = []) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n${
    outputs.length
      ? `outputs:\n${outputs.map((o) => (typeof o === "string" ? `  - name: ${o}\n` : `  - name: ${o.name}\n    type: ${o.type}\n`)).join("")}`
      : ""
  }---\n\nYou are ${name}.\n`;

const catalog = (mds: string[]) => {
  const agents = mds.map((m) => parseAgentString(m, "<e2e-code>"));
  return { agents, byName: new Map(agents.map((a) => [a.name, a])) };
};

const errorsOf = (r: { diagnostics: Array<{ severity: string; message: string }> }) =>
  r.diagnostics.filter((d) => d.severity === "error");

/** Validate (must be clean) then parse. */
function load(yaml: string, byName: Map<string, unknown>) {
  expect(errorsOf(validateFlowContent(yaml, () => byName as never, () => true))).toEqual([]);
  return parseFlowYamlString(yaml, "<e2e-code>");
}

const ok = (summary: string, extra: Record<string, unknown> = {}) =>
  scriptFinish({ status: "complete", summary, ...extra });

/** An assistant turn with reply text AND the finish call (gives the step a non-empty fullOutput). */
const replyThenFinish = (text: string, summary: string, extra: Record<string, unknown> = {}) =>
  fauxAssistantMessage([fauxText(text), fauxToolCall("finish", { status: "complete", summary, files: [], ...extra })]);

/** Records step starts/completions (code steps report through the same callbacks). */
function tracker() {
  const log: string[] = [];
  return {
    log,
    started: (id: string) => log.includes(`start:${id}`),
    count: (id: string) => log.filter((l) => l === `start:${id}`).length,
    onAgentStarted: (_a: string, stepId: string) => { log.push(`start:${stepId}`); },
    onAgentComplete: (_a: string, stepId: string) => { log.push(`done:${stepId}`); },
  };
}

/** Handler that echoes its whole input object back as the typed `seen` output. */
const ECHO = `export default async (input) => ({ seen: input });`;

const WORKERS = catalog([agentMd("worker"), agentMd("closer")]);

// ── 1. Input wiring into a code step ──────────────────────────────────────

describe("e2e code steps: inputs reach the handler", () => {
  it("${{task}} and ${{flow.input.x}}: whole-value flow inputs arrive typed, embedded ones serialized, ctx carries task/stepId", async () => {
    const yaml = `name: code-inputs
description: task and typed flow inputs into a code step
inputs:
  count: { type: number, required: true }
  strict: { type: boolean }
  config: { type: object }
  label: { type: string }
steps:
  - id: intake
    type: agent
    agent: worker
    task: "INTAKE \${{task}}"
  - id: probe
    type: code
    blockedBy: [intake]
    inputs:
      task_text: "\${{task}}"
      task_embedded: "ticket: \${{task}}"
      count: "\${{flow.input.count}}"
      strict: "\${{flow.input.strict}}"
      config: "\${{flow.input.config}}"
      config_text: "cfg=\${{flow.input.config}} n=\${{flow.input.count}} strict=\${{flow.input.strict}}"
      label: "\${{flow.input.label}}"
    outputs:
      - name: seen
      - name: ctx_info
`;
    // NOTE: not run through the validator — see the ENGINE BUG test below.
    const flow = parseFlowYamlString(yaml, "<e2e-code>");
    const result = await runFauxFlow({
      flow, agents: WORKERS.agents,
      task: "fix the login bug",
      flowInput: { count: 3, strict: false, config: { retries: 2, tags: ["a", "b"] } },
      codeHandlers: {
        probe: `export default async (input, ctx) => ({ seen: input, ctx_info: { task: ctx.task, stepId: ctx.stepId, flowName: ctx.flowName, hasSignal: ctx.signal instanceof AbortSignal } });`,
      },
      responder: () => ok("intake done"),
    });

    expect(result.status).toBe("success");
    const seen = result.results.probe.outputs.seen as Record<string, unknown>;
    expect(seen.task_text).toBe("fix the login bug");
    expect(seen.task_embedded).toBe("ticket: fix the login bug");
    expect(seen.count).toBe(3);
    expect(seen.strict).toBe(false);
    expect(seen.config).toEqual({ retries: 2, tags: ["a", "b"] });
    expect(seen.config_text).toBe('cfg={"retries":2,"tags":["a","b"]} n=3 strict=false');
    // declared but not provided → unresolved → ""
    expect(seen.label).toBe("");
    const info = result.results.probe.outputs.ctx_info as Record<string, unknown>;
    expect(info.task).toBe("fix the login bug");
    expect(info.stepId).toBe("probe");
    expect(typeof info.flowName).toBe("string");
    expect(info.hasSignal).toBe(true);
  });

  // ENGINE BUG: validateFlowContent rejects ${{flow.input.x}} as "unrecognized prefix \"flow\"" (known: result, input, task, loop) although docs document it.
  it.fails("the authoring validator accepts a declared ${{flow.input.x}} reference", () => {
    const yaml = `name: flow-input-ref
description: flow input into a code step
inputs:
  count: { type: number }
steps:
  - id: probe
    type: code
    inputs:
      count: "\${{flow.input.count}}"
    outputs:
      - name: seen
`;
    expect(errorsOf(validateFlowContent(yaml, () => WORKERS.byName, () => true))).toEqual([]);
  });

  it("agent standard fields: summary, status, reply text via fullOutput and bare ${{result.a}}", async () => {
    const yaml = `name: agent-fields
description: an agent's summary vs reply text into a code step
steps:
  - id: draft
    type: agent
    agent: worker
    task: "DRAFT release notes for \${{task}}"
  - id: inspect
    type: code
    blockedBy: [draft]
    inputs:
      summary: "\${{result.draft.summary}}"
      status: "\${{result.draft.status}}"
      full: "\${{result.draft.fullOutput}}"
      bare: "\${{result.draft}}"
      embedded: "S=[\${{result.draft.summary}}] T=[\${{result.draft.status}}]"
    outputs:
      - name: seen
`;
    const flow = load(yaml, WORKERS.byName);
    const result = await runFauxFlow({
      flow, agents: WORKERS.agents, task: "v2.1",
      codeHandlers: { inspect: ECHO },
      responder: () => replyThenFinish("## v2.1\n- faster startup\n- fixed login", "Wrote the release notes"),
    });

    expect(result.status).toBe("success");
    const seen = result.results.inspect.outputs.seen as Record<string, string>;
    // summary is the agent's description of its work, not its content
    expect(seen.summary).toBe("Wrote the release notes");
    expect(seen.status).toBe("complete");
    // fullOutput / bare reference carry the reply text
    expect(seen.full).toContain("- faster startup");
    expect(seen.full).not.toBe(seen.summary);
    expect(seen.bare).toBe(seen.full);
    expect(seen.embedded).toBe("S=[Wrote the release notes] T=[complete]");
  });

  it("typed agent outputs (number/boolean) arrive typed as whole values and serialized when embedded", async () => {
    const yaml = `name: typed-agent-outputs
description: typed agent outputs into a code step and an agent
steps:
  - id: measure
    type: agent
    agent: measurer
    task: "MEASURE the repo"
  - id: inspect
    type: code
    blockedBy: [measure]
    inputs:
      count: "\${{result.measure.count}}"
      passed: "\${{result.measure.passed}}"
      line: "n=\${{result.measure.count}} ok=\${{result.measure.passed}}"
    outputs:
      - name: seen
      - name: kinds
  - id: report
    type: agent
    agent: closer
    blockedBy: [measure]
    task: "REPORT n=\${{result.measure.count}} ok=\${{result.measure.passed}}"
`;
    const cat = catalog([
      agentMd("measurer", [{ name: "count", type: "number" }, { name: "passed", type: "boolean" }]),
      agentMd("closer"),
    ]);
    let reportTask = "";
    const result = await runFauxFlow({
      flow: load(yaml, cat.byName), agents: cat.agents,
      codeHandlers: { inspect: `export default async (input) => ({ seen: input, kinds: [typeof input.count, typeof input.passed] });` },
      responder: (t) => {
        if (/REPORT/.test(t)) { reportTask = t; return ok("reported"); }
        return ok("measured", { count: "7", passed: "true" });
      },
    });

    expect(result.status).toBe("success");
    expect(result.results.measure.outputs).toEqual({ count: 7, passed: true });
    const seen = result.results.inspect.outputs.seen as Record<string, unknown>;
    expect(seen.count).toBe(7);
    expect(seen.passed).toBe(true);
    expect(result.results.inspect.outputs.kinds).toEqual(["number", "boolean"]);
    expect(seen.line).toBe("n=7 ok=true");
    expect(reportTask).toContain("REPORT n=7 ok=true");
  });

  // ENGINE BUG: the finish schema types every declared output as Type.String, so a `type: object` output emitted as an object is rejected ("meta: must be string") and the step fails.
  it.fails("a `type: object` agent output emitted as an object is accepted and arrives typed in a code step / compact JSON in text", async () => {
    const yaml = `name: typed-agent-outputs
description: typed agent outputs into a code step and an agent
steps:
  - id: measure
    type: agent
    agent: measurer
    task: "MEASURE the repo"
  - id: inspect
    type: code
    blockedBy: [measure]
    inputs:
      count: "\${{result.measure.count}}"
      passed: "\${{result.measure.passed}}"
      meta: "\${{result.measure.meta}}"
      line: "n=\${{result.measure.count}} ok=\${{result.measure.passed}} meta=\${{result.measure.meta}}"
    outputs:
      - name: seen
      - name: kinds
  - id: report
    type: agent
    agent: closer
    blockedBy: [measure]
    task: "REPORT n=\${{result.measure.count}} ok=\${{result.measure.passed}} meta=\${{result.measure.meta}}"
`;
    const cat = catalog([
      agentMd("measurer", [{ name: "count", type: "number" }, { name: "passed", type: "boolean" }, { name: "meta", type: "object" }]),
      agentMd("closer"),
    ]);
    const flow = load(yaml, cat.byName);
    let reportTask = "";
    const result = await runFauxFlow({
      flow, agents: cat.agents,
      codeHandlers: {
        inspect: `export default async (input) => ({ seen: input, kinds: [typeof input.count, typeof input.passed, Array.isArray(input.meta.files) ? "object+array" : typeof input.meta] });`,
      },
      responder: (t) => {
        if (/REPORT/.test(t)) { reportTask = t; return ok("reported"); }
        return ok("measured", { count: 7, passed: true, meta: { lang: "ts", files: ["a.ts", "b.ts"] } });
      },
    });

    expect(result.status).toBe("success");
    const seen = result.results.inspect.outputs.seen as Record<string, unknown>;
    expect(seen.count).toBe(7);
    expect(seen.passed).toBe(true);
    expect(seen.meta).toEqual({ lang: "ts", files: ["a.ts", "b.ts"] });
    expect(result.results.inspect.outputs.kinds).toEqual(["number", "boolean", "object+array"]);
    expect(seen.line).toBe('n=7 ok=true meta={"lang":"ts","files":["a.ts","b.ts"]}');
    expect(reportTask).toContain('REPORT n=7 ok=true meta={"lang":"ts","files":["a.ts","b.ts"]}');
  });

  // ENGINE BUG: resolveCodeInput returns the reply text for a whole-value ${{result.X.fullOutput}} even when X declares a `fullOutput` output (text expansion honours the declared output).
  it.fails("a declared agent output named `fullOutput` takes precedence over the reply text, also for a whole-value code input", async () => {
    const yaml = `name: fulloutput-precedence
description: declared fullOutput wins
steps:
  - id: gen
    type: agent
    agent: generator
    task: "GENERATE"
  - id: inspect
    type: code
    blockedBy: [gen]
    inputs:
      whole: "\${{result.gen.fullOutput}}"
      embedded: "[\${{result.gen.fullOutput}}]"
    outputs:
      - name: seen
`;
    const cat = catalog([agentMd("generator", ["fullOutput"])]);
    const flow = load(yaml, cat.byName);
    const result = await runFauxFlow({
      flow, agents: cat.agents,
      codeHandlers: { inspect: ECHO },
      responder: () => replyThenFinish("chatty reply text", "generated", { fullOutput: "DECLARED-VALUE" }),
    });
    expect(result.status).toBe("success");
    const seen = result.results.inspect.outputs.seen as Record<string, string>;
    expect(seen.embedded).toBe("[DECLARED-VALUE]");
    expect(seen.whole).toBe("DECLARED-VALUE");
  });
});

// ── 2. Code outputs consumed downstream ───────────────────────────────────

describe("e2e code steps: outputs flow on to agents and other code steps", () => {
  const YAML = `name: code-outputs
description: a code step's typed outputs into an agent task and another code step
steps:
  - id: plan
    type: agent
    agent: worker
    task: "PLAN \${{task}}"
  - id: compute
    type: code
    blockedBy: [plan]
    inputs:
      plan: "\${{result.plan.summary}}"
    outputs:
      - name: n
      - name: flag
      - name: obj
      - name: list
  - id: report
    type: agent
    agent: closer
    blockedBy: [compute]
    task: "REPORT n=\${{result.compute.n}} flag=\${{result.compute.flag}} obj=\${{result.compute.obj}} list=\${{result.compute.list}} status=\${{result.compute.status}} summary=\${{result.compute.summary}}"
  - id: consume
    type: code
    blockedBy: [compute]
    inputs:
      n: "\${{result.compute.n}}"
      flag: "\${{result.compute.flag}}"
      obj: "\${{result.compute.obj}}"
      list: "\${{result.compute.list}}"
    outputs:
      - name: kinds
      - name: doubled
`;
  const COMPUTE = `export default async (input, ctx) => {
  ctx.setSummary("computed from " + input.plan);
  return { n: 42, flag: false, obj: { a: 1, nested: { b: [true] } }, list: [1, "x"] };
};`;
  const CONSUME = `export default async (i) => ({
  kinds: [typeof i.n, typeof i.flag, typeof i.obj, Array.isArray(i.list)],
  doubled: i.n * 2,
});`;

  it("embedded in agent text → compact JSON; whole-value into code → real types; setSummary drives ${{result.X.summary}}", async () => {
    let reportTask = "";
    const result = await runFauxFlow({
      flow: load(YAML, WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { compute: COMPUTE, consume: CONSUME },
      responder: (t) => {
        if (/REPORT/.test(t)) { reportTask = t; return ok("reported"); }
        return ok("PLANNED-3-STEPS");
      },
    });

    expect(result.status).toBe("success");
    expect(result.results.compute.outputs).toEqual({ n: 42, flag: false, obj: { a: 1, nested: { b: [true] } }, list: [1, "x"] });
    expect(result.results.compute.summary).toBe("computed from PLANNED-3-STEPS");
    expect(reportTask).toContain('REPORT n=42 flag=false obj={"a":1,"nested":{"b":[true]}} list=[1,"x"] status=complete summary=computed from PLANNED-3-STEPS');
    expect(result.results.consume.outputs.kinds).toEqual(["number", "boolean", "object", true]);
    expect(result.results.consume.outputs.doubled).toBe(84);
  });

  // ENGINE BUG: resolveCodeInput maps a stored null output to "" (`?? ""`) instead of delivering the JSON null unchanged.
  it.fails("a `null` code output reaches a whole-value code input as null", async () => {
    const yaml = `name: null-handoff
description: null output whole-value into code
steps:
  - id: source
    type: code
    outputs:
      - name: maybe
  - id: sink
    type: code
    blockedBy: [source]
    inputs:
      maybe: "\${{result.source.maybe}}"
    outputs:
      - name: seen_null
`;
    const result = await runFauxFlow({
      flow: load(yaml, WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: {
        source: `export default async () => ({ maybe: null });`,
        sink: `export default async (i) => ({ seen_null: i.maybe === null });`,
      },
      responder: () => ok("unused"),
    });
    expect(result.status).toBe("success");
    expect(result.results.source.outputs.maybe).toBeNull();
    expect(result.results.sink.outputs.seen_null).toBe(true);
  });
});

// ── 3. Return contract ────────────────────────────────────────────────────

describe("e2e code steps: return contract violations are soft failures", () => {
  const contractFlow = (onError: boolean) => `name: contract
description: shape check
steps:
  - id: extract
    type: agent
    agent: worker
    task: "EXTRACT"
  - id: shape
    type: code
    blockedBy: [extract]
    outputs:
      - name: a
      - name: b
${onError ? "    on_error: recover\n" : ""}  - id: publish
    type: agent
    agent: closer
    blockedBy: [shape]
    task: "PUBLISH \${{result.shape.a}}"
${onError ? `  - id: recover
    type: agent
    agent: closer
    task: "RECOVER because \${{result.shape.summary}}"
` : ""}`;

  it("missing declared output → routes to on_error; recovery sees the message naming the key", async () => {
    const t = tracker();
    let recoverTask = "";
    const result = await runFauxFlow({
      flow: load(contractFlow(true), WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { shape: `export default async () => ({ a: 1 });` },
      responder: (task) => {
        if (/RECOVER/.test(task)) { recoverTask = task; return ok("recovered"); }
        return ok("fine");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).not.toBe("error");
    expect(result.results.shape.status).toBe("error");
    expect(recoverTask).toContain('"b"');
    expect(t.started("publish")).toBe(false);
  });

  it("undeclared extra key without on_error → the flow halts naming the key; downstream never starts", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: load(contractFlow(false), WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { shape: `export default async () => ({ a: 1, b: 2, sneaky: 3 });` },
      responder: () => ok("fine"),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary + result.lastResult.output).toContain("sneaky");
    expect(t.started("publish")).toBe(false);
  });

  it("a step with no outputs returning {} succeeds; a missing handler file is a soft failure routed to on_error", async () => {
    const yaml = `name: housekeeping
description: no-output step then a step whose handler is missing
steps:
  - id: touch
    type: code
  - id: ghost
    type: code
    blockedBy: [touch]
    target: ./__tests__/fixtures/e2e-code/does-not-exist.mjs
    on_error: recover
  - id: recover
    type: agent
    agent: closer
    task: "RECOVER \${{result.ghost.summary}}"
`;
    let recoverTask = "";
    const result = await runFauxFlow({
      flow: load(yaml, WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { touch: `export default async () => ({});` },
      responder: (t) => { recoverTask = t; return ok("recovered"); },
    });
    expect(result.results.touch.status).toBe("complete");
    expect(result.results.touch.outputs).toEqual({});
    expect(result.results.ghost.status).toBe("error");
    expect(recoverTask).toMatch(/not found/i);
    expect(result.results.recover.status).toBe("complete");
    expect(result.status).not.toBe("error");
  });
});

// ── 4. Failure routing ────────────────────────────────────────────────────

describe("e2e code steps: failure → on_error, or halt", () => {
  const pipeline = (onError: string) => `name: build-check
description: build, check with code, publish
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD \${{task}}"
  - id: check
    type: code
    blockedBy: [build]
    inputs:
      build: "\${{result.build.summary}}"
${onError}  - id: publish
    type: agent
    agent: closer
    blockedBy: [check]
    task: "PUBLISH"
  - id: announce
    type: agent
    agent: closer
    blockedBy: [publish]
    task: "ANNOUNCE"
`;
  const withRecover = (extra = "") => pipeline(`    on_error: recover\n${extra}`) + `  - id: recover
    type: agent
    agent: closer
    task: "RECOVER from \${{result.check.summary}}"
`;

  it("a throwing check routes to on_error; the normal continuation is skipped and the flow does not error", async () => {
    const t = tracker();
    let recoverTask = "";
    const result = await runFauxFlow({
      flow: load(withRecover(), WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { check: `export default async (i) => { throw new Error("checksum mismatch in " + i.build); };` },
      responder: (task) => {
        if (/RECOVER/.test(task)) { recoverTask = task; return ok("rolled back"); }
        return ok("artifact-7");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).not.toBe("error");
    expect(result.results.check.status).toBe("error");
    expect(recoverTask).toContain("checksum mismatch in artifact-7");
    expect(result.results.recover.summary).toBe("rolled back");
    expect(t.started("publish")).toBe(false);
    expect(t.started("announce")).toBe(false);
  });

  it("without on_error a throwing check halts the flow; nothing after it starts", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: load(pipeline(""), WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { check: `export default async () => { throw new Error("disk full"); };` },
      responder: () => ok("artifact-7"),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary + result.lastResult.output).toContain("disk full");
    expect(t.started("build")).toBe(true);
    expect(t.started("publish")).toBe(false);
    expect(t.started("announce")).toBe(false);
  });

  it("a code step exceeding `timeout` aborts ctx.signal and soft-fails to on_error", async () => {
    const g = globalThis as Record<string, unknown>;
    g.__e2eCodeAborted = false;
    const t = tracker();
    const started = Date.now();
    const result = await runFauxFlow({
      flow: load(withRecover("    timeout: 60\n"), WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: {
        check: `export default (_i, ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => { globalThis.__e2eCodeAborted = true; }); });`,
      },
      responder: (task) => ok(/RECOVER/.test(task) ? `recovered: ${task}` : "artifact"),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    const aborted = g.__e2eCodeAborted;
    delete g.__e2eCodeAborted;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(aborted).toBe(true);
    expect(result.results.check.status).toBe("error");
    expect(result.results.recover.summary).toMatch(/timeout/i);
    expect(t.started("publish")).toBe(false);
    expect(result.status).not.toBe("error");
  });
});

// ── 5. Fan-out → code aggregation ─────────────────────────────────────────

describe("e2e code steps: three parallel reviewers, code tallies the majority (fixture flow with co-located handlers)", () => {
  const FIXTURE_DIR = join(__dirname, "fixtures", "e2e-code", "votes");
  const FLOW_PATH = join(FIXTURE_DIR, "flow.yaml");
  const cat = catalog([
    agentMd("reviewer", ["verdict", { name: "confidence", type: "number" }]),
    agentMd("closer"),
  ]);

  const cases: Array<{ name: string; votes: Record<string, string>; branch: string; counts: Record<string, number> }> = [
    { name: "2 approve / 1 reject → ship", votes: { A: "approve", B: "approve", C: "reject" }, branch: "ship", counts: { approve: 2, reject: 1, abstain: 0 } },
    { name: "1 approve / 2 reject → rework", votes: { A: "reject", B: "approve", C: "reject" }, branch: "rework", counts: { approve: 1, reject: 2, abstain: 0 } },
    { name: "1 approve / 1 reject / 1 abstain → escalate", votes: { A: "approve", B: "abstain", C: "reject" }, branch: "escalate", counts: { approve: 1, reject: 1, abstain: 1 } },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const yaml = readFileSync(FLOW_PATH, "utf8");
      const flow = load(yaml, cat.byName);
      // the source path makes `<flow-dir>/<id>.ts` the handler location
      flow.source = FLOW_PATH;
      const t = tracker();
      const closerTasks: string[] = [];
      const result = await runFaux({
        flow, agents: cat.agents, task: "PR #12",
        responder: (task) => {
          const r = /REVIEW-([ABC])/.exec(task);
          if (r) return ok(`reviewed ${r[1]}`, { verdict: c.votes[r[1]], confidence: { A: 0.9, B: 0.6, C: 0.3 }[r[1]] });
          closerTasks.push(task);
          return ok("closed");
        },
        onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
      });

      expect(result.status).toBe("success");
      // all three reviewers completed before the aggregator started
      for (const id of ["review-a", "review-b", "review-c"]) {
        expect(t.log.indexOf(`done:${id}`)).toBeLessThan(t.log.indexOf("start:tally"));
      }
      expect(result.results.tally.outputs.counts).toEqual(c.counts);
      // typed number outputs reached the handler as numbers
      expect(result.results.tally.outputs.mean_confidence).toBeCloseTo(0.6, 10);
      expect(result.results.tally.summary).toMatch(/^votes \d\/\d\/\d -> /);
      for (const target of ["ship", "rework", "escalate"]) {
        if (target === c.branch) expect(result.results[target].status).toBe("complete");
        else {
          expect(result.results[target].status).toBe("skipped");
          expect(t.started(target)).toBe(false);
        }
      }
      expect(closerTasks).toHaveLength(1);
      expect(closerTasks[0]).toContain(`counts=${JSON.stringify(c.counts)}`);
    });
  }
});

describe("e2e code steps: a join code step reading an untaken branch", () => {
  it("the skipped branch's summary / declared output resolve to \"\", its status to \"skipped\"", async () => {
    const yaml = `name: fast-or-slow
description: pick a path, join with code
steps:
  - id: size
    type: code
    outputs:
      - name: files
  - id: pick
    type: code-decision
    blockedBy: [size]
    inputs:
      files: "\${{result.size.files}}"
    branches:
      fast: fast
      slow: slow
  - id: fast
    type: agent
    agent: quick
    task: "FAST path"
  - id: slow
    type: agent
    agent: thorough
    task: "SLOW path"
  - id: join
    type: code
    blockedBy: [fast, slow]
    inputs:
      fast_sum: "\${{result.fast.summary}}"
      fast_out: "\${{result.fast.notes}}"
      slow_sum: "\${{result.slow.summary}}"
      slow_out: "\${{result.slow.notes}}"
      slow_status: "\${{result.slow.status}}"
      slow_text: "slow=[\${{result.slow.summary}}][\${{result.slow.notes}}]"
    outputs:
      - name: seen
`;
    const cat = catalog([agentMd("quick", ["notes"]), agentMd("thorough", ["notes"])]);
    const result = await runFauxFlow({
      flow: load(yaml, cat.byName), agents: cat.agents,
      codeHandlers: {
        size: `export default async () => ({ files: 2 });`,
        pick: `export default async (i) => ({ branch: i.files < 10 ? "fast" : "slow" });`,
        join: ECHO,
      },
      responder: (t) => ok(/FAST/.test(t) ? "fast done" : "slow done", { notes: /FAST/.test(t) ? "quick notes" : "deep notes" }),
    });
    expect(result.status).toBe("success");
    const seen = result.results.join.outputs.seen as Record<string, unknown>;
    expect(seen.fast_sum).toBe("fast done");
    expect(seen.fast_out).toBe("quick notes");
    expect(seen.slow_sum).toBe("");
    expect(seen.slow_out).toBe("");
    expect(seen.slow_status).toBe("skipped");
    expect(seen.slow_text).toBe("slow=[][]");
    expect(JSON.stringify(seen)).not.toContain("undefined");
  });
});

// ── 6. Reserved output names on code nodes ────────────────────────────────

describe("e2e code steps: reserved output names", () => {
  it("a code step may declare outputs named `summary` / `status` (only agents reserve finish fields); values are stored as typed outputs", async () => {
    const yaml = `name: code-summary-status
description: code step with summary/status outputs
steps:
  - id: grade
    type: code
    outputs:
      - name: summary
      - name: status
`;
    const diags = validateFlowContent(yaml, () => WORKERS.byName, () => true);
    expect(errorsOf(diags)).toEqual([]);
    const result = await runFauxFlow({
      flow: parseFlowYamlString(yaml, "<e2e-code>"), agents: WORKERS.agents,
      codeHandlers: { grade: `export default async () => ({ summary: "3 of 4 checks passed", status: "amber" });` },
      responder: () => ok("unused"),
    });
    expect(result.status).toBe("success");
    expect(result.results.grade.outputs).toEqual({ summary: "3 of 4 checks passed", status: "amber" });
    // the step itself still succeeded — a returned `status` value does not change the step outcome
    expect(result.results.grade.status).toBe("complete");
  });

  it("a code-decision declaring `branch` as a data output is a validation error", () => {
    const yaml = `name: bad-branch
description: branch declared as output
steps:
  - id: route
    type: code-decision
    outputs:
      - name: branch
    branches:
      a: one
      b: two
  - id: one
    type: agent
    agent: worker
    task: "ONE"
  - id: two
    type: agent
    agent: worker
    task: "TWO"
`;
    const r = validateFlowContent(yaml, () => WORKERS.byName, () => true);
    expect(r.valid).toBe(false);
    expect(errorsOf(r).some((d) => /branch/.test(d.message) && /reserved/i.test(d.message))).toBe(true);
  });

  it("a plain `code` step MAY declare an output named `branch` (reserved only on code-decision) and it flows downstream", async () => {
    const yaml = `name: plain-code-branch
description: branch is a data output on a plain code step
steps:
  - id: classify
    type: code
    outputs:
      - name: branch
  - id: report
    type: agent
    agent: closer
    blockedBy: [classify]
    task: "REPORT git branch \${{result.classify.branch}}"
`;
    let reportTask = "";
    const result = await runFauxFlow({
      flow: load(yaml, WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { classify: `export default async () => ({ branch: "feature/login" });` },
      responder: (t) => { reportTask = t; return ok("reported"); },
    });
    expect(result.status).toBe("success");
    expect(result.results.classify.outputs.branch).toBe("feature/login");
    expect(reportTask).toContain("REPORT git branch feature/login");
  });
});
