/**
 * End-to-end faux scenarios for `code-decision` routing and code-driven loops:
 * every branch of a multi-way map, off-map / missing / non-string branches,
 * throwing and timing-out handlers, loop-back counting against
 * `max_iterations`, and realistic shapes ("lint â fix loop", "validate an
 * agent's JSON and loop back on invalid").
 *
 * Written from docs/flows.md "Code Decision Step", "Loops", "Loop iteration is
 * 1-based", "Routing Node Semantics", "Failure Modes". Flows/agents authored as
 * YAML/markdown, validated, parsed, and run on the real runFlow with the faux
 * provider; handlers supplied via runFauxFlow `codeHandlers`.
 *
 * Plain `code` step wiring/contract/failure scenarios live in
 * e2e-faux-code-steps.test.ts.
 */
import { describe, expect, it } from "vitest";
import { runFauxFlow, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";

// ââ helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

const validate = (yaml: string, byName: Map<string, unknown>) =>
  validateFlowContent(yaml, () => byName as never, () => true);

/** Validate (must be clean) then parse. */
function load(yaml: string, byName: Map<string, unknown>) {
  expect(errorsOf(validate(yaml, byName))).toEqual([]);
  return parseFlowYamlString(yaml, "<e2e-code>");
}

const ok = (summary: string, extra: Record<string, unknown> = {}) =>
  scriptFinish({ status: "complete", summary, ...extra });

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

const failureText = (r: { lastResult: { output: string; result: { summary: string } } }) =>
  `${r.lastResult.result.summary}\n${r.lastResult.output}`;

const WORKERS = catalog([agentMd("worker"), agentMd("closer"), agentMd("triager", [{ name: "score", type: "number" }])]);

// ââ 1. Three-way routing ââââââââââââââââââââââââââââââââââââââââââââââââââ

describe("e2e code-decision: three-way approval routing", () => {
  const YAML = `name: approval
description: triage scores a change, code routes it
steps:
  - id: triage
    type: agent
    agent: triager
    task: "TRIAGE \${{task}}"
  - id: route
    type: code-decision
    blockedBy: [triage]
    inputs:
      score: "\${{result.triage.score}}"
    outputs:
      - name: approvers
    branches:
      auto_approve: export
      needs_human: human-review
      park: hold
  - id: export
    type: agent
    agent: closer
    task: "EXPORT approvers=\${{result.route.approvers}}"
  - id: human-review
    type: agent
    agent: closer
    task: "HUMAN-REVIEW approvers=\${{result.route.approvers}}"
  - id: hold
    type: agent
    agent: closer
    task: "HOLD"
`;
  // the score arrives as a number (whole-value reference to a `type: number` output)
  const ROUTE = `export default async (input) => {
  if (typeof input.score !== "number") return { branch: "score-was-" + typeof input.score, approvers: [] };
  if (input.score >= 0.9) return { branch: "auto_approve", approvers: ["alice", "bob"] };
  if (input.score >= 0.5) return { branch: "needs_human", approvers: ["carol"] };
  return { branch: "park", approvers: [] };
};`;
  const TARGETS = ["export", "human-review", "hold"];

  const cases = [
    { score: "0.95", target: "export", approvers: ["alice", "bob"], task: 'EXPORT approvers=["alice","bob"]' },
    { score: "0.6", target: "human-review", approvers: ["carol"], task: 'HUMAN-REVIEW approvers=["carol"]' },
    { score: "0.1", target: "hold", approvers: [], task: "HOLD" },
  ];

  for (const c of cases) {
    it(`score ${c.score} â ${c.target}; the other two branches are skipped, data output flows into the branch task`, async () => {
      const t = tracker();
      const tasks: string[] = [];
      const result = await runFauxFlow({
        flow: load(YAML, WORKERS.byName), agents: WORKERS.agents,
        codeHandlers: { route: ROUTE },
        responder: (task) => {
          if (/TRIAGE/.test(task)) return ok("triaged", { score: c.score });
          tasks.push(task);
          return ok("handled");
        },
        onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
      });
      expect(result.status).toBe("success");
      expect(result.results.route.status).toBe("complete");
      expect(result.results.route.outputs.approvers).toEqual(c.approvers);
      for (const target of TARGETS) {
        if (target === c.target) expect(result.results[target].status).toBe("complete");
        else {
          expect(result.results[target].status).toBe("skipped");
          expect(t.started(target)).toBe(false);
        }
      }
      expect(tasks).toEqual([`Task: ${c.task}`]);
    });
  }
});

// ââ 2. Branch-contract failures âââââââââââââââââââââââââââââââââââââââââââ

describe("e2e code-decision: bad branches and failing handlers", () => {
  const routed = (onError: boolean, extra = "") => `name: gated
description: code gate between build and two paths
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
  - id: gate
    type: code-decision
    blockedBy: [build]
    inputs:
      build: "\${{result.build.summary}}"
    branches:
      ship: ship
      fix: fix
${onError ? "    on_error: recover\n" : ""}${extra}  - id: ship
    type: agent
    agent: closer
    task: "SHIP"
  - id: fix
    type: agent
    agent: closer
    task: "FIX"
${onError ? `  - id: recover
    type: agent
    agent: closer
    task: "RECOVER after \${{result.gate.summary}}"
` : ""}`;

  const run = (yaml: string, handler: string) => {
    const t = tracker();
    const tasks: string[] = [];
    // NOTE: parsed without the validator — see the ENGINE BUG test on code-decision on_error ordering below.
    const p = runFauxFlow({
      flow: parseFlowYamlString(yaml, "<e2e-code>"), agents: WORKERS.agents,
      codeHandlers: { gate: handler },
      responder: (task) => { tasks.push(task); return ok(/BUILD/.test(task) ? "built" : "done"); },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    return p.then((result) => ({ result, t, tasks }));
  };

  it("an off-map branch is a HARD failure: the flow halts even though on_error is declared", async () => {
    const { result, t } = await run(routed(true), `export default async () => ({ branch: "deploy-to-prod" });`);
    expect(result.status).toBe("error");
    expect(failureText(result)).toContain("deploy-to-prod");
    for (const id of ["ship", "fix", "recover"]) expect(t.started(id)).toBe(false);
  });

  it("an off-map branch without on_error also halts the flow", async () => {
    const { result, t } = await run(routed(false), `export default async () => ({ branch: "SHIP" });`);
    expect(result.status).toBe("error");
    expect(t.started("ship")).toBe(false);
    expect(t.started("fix")).toBe(false);
  });

  // ENGINE BUG: executeCodeDecisionStep escalates every handler failure to hard and ignores on_error (docs: soft failure routes to on_error).
  it.fails("a missing `branch` is a SOFT failure: routes to on_error with a message naming the reserved output", async () => {
    const { result, t, tasks } = await run(routed(true), `export default async () => ({});`);
    expect(result.status).not.toBe("error");
    expect(result.results.gate.status).toBe("error");
    expect(tasks.find((x) => /RECOVER/.test(x))).toContain('"branch"');
    expect(t.started("ship")).toBe(false);
    expect(t.started("fix")).toBe(false);
  });

  it("a missing `branch` without on_error hard-fails the flow", async () => {
    const { result, t } = await run(routed(false), `export default async () => ({});`);
    expect(result.status).toBe("error");
    expect(failureText(result)).toContain("branch");
    expect(t.started("ship")).toBe(false);
  });

  // ENGINE BUG: executeCodeDecisionStep escalates every handler failure to hard and ignores on_error (docs: soft failure routes to on_error).
  it.fails("a non-string `branch` is a soft failure routed to on_error", async () => {
    const { result, t } = await run(routed(true), `export default async () => ({ branch: 1 });`);
    expect(result.results.gate.status).toBe("error");
    expect(result.results.recover.status).toBe("complete");
    expect(t.started("ship")).toBe(false);
    expect(result.status).not.toBe("error");
  });

  // ENGINE BUG: executeCodeDecisionStep escalates every handler failure to hard and ignores on_error (docs: soft failure routes to on_error).
  it.fails("a throwing handler routes to on_error; the recovery step sees the thrown message", async () => {
    const { result, tasks, t } = await run(routed(true), `export default async (i) => { throw new Error("cannot parse " + i.build); };`);
    expect(result.status).not.toBe("error");
    expect(tasks.find((x) => /RECOVER/.test(x))).toContain("cannot parse built");
    expect(t.started("ship")).toBe(false);
    expect(t.started("fix")).toBe(false);
  });

  it("a throwing handler without on_error halts the flow", async () => {
    const { result, t } = await run(routed(false), `export default async () => { throw new Error("gate exploded"); };`);
    expect(result.status).toBe("error");
    expect(failureText(result)).toContain("gate exploded");
    expect(t.started("ship")).toBe(false);
  });

  // ENGINE BUG: executeCodeDecisionStep escalates every handler failure to hard and ignores on_error (docs: soft failure routes to on_error).
  it.fails("a handler exceeding `timeout` soft-fails to on_error", async () => {
    const started = Date.now();
    const { result, tasks, t } = await run(
      routed(true, "    timeout: 50\n"),
      `export default (_i, ctx) => new Promise((resolve) => { const h = setTimeout(() => resolve({ branch: "ship" }), 5000); ctx.signal.addEventListener("abort", () => clearTimeout(h)); });`,
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.results.gate.status).toBe("error");
    expect(tasks.find((x) => /RECOVER/.test(x))).toMatch(/timeout/i);
    expect(t.started("ship")).toBe(false);
    expect(result.status).not.toBe("error");
  });
});

// ââ 3. Validation of code-decision definitions ââââââââââââââââââââââââââââ

describe("e2e code-decision: authoring validation", () => {
  // ENGINE BUG: the validator does not treat a code-decision's on_error edge as ordering, so a recovery step reading ${{result.<gate>.summary}} is rejected (docs rule 3: on_error edge chains order).
  it.fails("a recovery step reached via a code-decision's on_error may reference the decision's result", () => {
    const yaml = `name: v
description: validation
steps:
  - id: gate
    type: code-decision
    branches:
      a: one
      b: two
    on_error: recover
  - id: one
    type: agent
    agent: worker
    task: "ONE"
  - id: two
    type: agent
    agent: worker
    task: "TWO"
  - id: recover
    type: agent
    agent: closer
    task: "RECOVER \${{result.gate.summary}}"
`;
    expect(errorsOf(validate(yaml, WORKERS.byName))).toEqual([]);
  });

  const base = (branches: string, extra = "") => `name: v
description: validation
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK"
  - id: gate
    type: code-decision
    blockedBy: [work]
    branches:
${branches}${extra}  - id: done
    type: agent
    agent: closer
    task: "DONE"
`;

  it("fewer than 2 branches is an error", () => {
    const r = validate(base("      only: done\n"), WORKERS.byName);
    expect(r.valid).toBe(false);
    expect(errorsOf(r).some((d) => d.message.includes("gate"))).toBe(true);
  });

  it("a backward branch without max_iterations is an error; adding it makes the flow valid", () => {
    const loop = "      again: work\n      done: done\n";
    const bad = validate(base(loop), WORKERS.byName);
    expect(bad.valid).toBe(false);
    expect(errorsOf(bad).some((d) => /max_iterations/.test(d.message))).toBe(true);
    expect(errorsOf(validate(base(loop, "    max_iterations: 2\n"), WORKERS.byName))).toEqual([]);
  });

  it("a branch target that does not exist is an error naming it", () => {
    const r = validate(base("      ok: done\n      nope: ghost\n"), WORKERS.byName);
    expect(r.valid).toBe(false);
    expect(errorsOf(r).some((d) => d.message.includes("ghost"))).toBe(true);
  });
});

// ââ 4. Loop counting ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

describe("e2e code-decision loop: max_iterations caps loop-backs", () => {
  const YAML = `name: capped-loop
description: body + code decision that always wants another pass
steps:
  - id: body
    type: agent
    agent: worker
    task: "BODY pass \${{loop.check.iteration}} of max \${{loop.check.max}}"
  - id: check
    type: code-decision
    blockedBy: [body]
    inputs:
      pass: "\${{loop.check.iteration}}"
      max: "\${{loop.check.max}}"
    outputs:
      - name: seen_pass
    branches:
      again: body
      done: wrap
    max_iterations: 2
  - id: wrap
    type: agent
    agent: closer
    task: "WRAP after \${{result.check.seen_pass}}"
`;

  it("max_iterations: 2 â body runs 3 times; iteration is 1-based and identical in body and decision; then falls through", async () => {
    const t = tracker();
    const bodyPasses: string[] = [];
    let wrapTask = "";
    const g = globalThis as Record<string, unknown>;
    g.__e2eLoopSeen = [];
    const result = await runFauxFlow({
      flow: load(YAML, WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: {
        check: `export default async (i) => { globalThis.__e2eLoopSeen.push(i.pass + "/" + i.max); return { branch: "again", seen_pass: i.pass }; };`,
      },
      responder: (task) => {
        const m = /BODY pass (\S+) of max (\S+)/.exec(task);
        if (m) { bodyPasses.push(`${m[1]}/${m[2]}`); return ok(`pass ${m[1]}`); }
        wrapTask = task;
        return ok("wrapped");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    const decisionSaw = g.__e2eLoopSeen;
    delete g.__e2eLoopSeen;

    expect(result.status).toBe("success");
    // first pass + 2 loop-backs
    expect(t.count("body")).toBe(3);
    expect(t.count("check")).toBe(3);
    expect(bodyPasses).toEqual(["1/2", "2/2", "3/2"]);
    expect(decisionSaw).toEqual(["1/2", "2/2", "3/2"]);
    // routing node outputs reflect the LAST iteration
    expect(result.results.check.outputs.seen_pass).toBe("3");
    expect(wrapTask).toBe("Task: WRAP after 3");
    expect(t.log.lastIndexOf("done:body")).toBeLessThan(t.log.indexOf("start:wrap"));
  });

  it("max_iterations: 1 â exactly one loop-back (body runs twice)", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: load(YAML.replace("max_iterations: 2", "max_iterations: 1"), WORKERS.byName), agents: WORKERS.agents,
      codeHandlers: { check: `export default async (i) => ({ branch: "again", seen_pass: i.pass });` },
      responder: () => ok("x"),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("success");
    expect(t.count("body")).toBe(2);
    expect(result.results.wrap.status).toBe("complete");
  });
});

// ââ 5. Realistic: lint â fix loop âââââââââââââââââââââââââââââââââââââââââ

describe("e2e code steps realistic: lint â fix loop gated on a numeric error count", () => {
  const YAML = `name: lint-fix
description: fixer agent, code linter, code-decision on the error count
inputs:
  issues: { type: array, required: true }
steps:
  - id: fix
    type: agent
    agent: fixer
    task: "FIX pass \${{loop.gate.iteration}}/\${{loop.gate.max}}"
  - id: lint
    type: code
    blockedBy: [fix]
    inputs:
      issues: "\${{flow.input.issues}}"
      fixed: "\${{result.fix.fixed}}"
    outputs:
      - name: errors
      - name: remaining
  - id: gate
    type: code-decision
    blockedBy: [lint]
    inputs:
      errors: "\${{result.lint.errors}}"
    branches:
      dirty: fix
      clean: report
    max_iterations: 4
  - id: report
    type: agent
    agent: closer
    task: "REPORT errors=\${{result.lint.errors}} remaining=\${{result.lint.remaining}}"
`;
  const LINT = `export default async (i, ctx) => {
  const fixed = String(i.fixed).split(",").map((s) => s.trim()).filter(Boolean);
  const remaining = i.issues.filter((x) => !fixed.includes(x));
  ctx.setSummary(remaining.length + " lint errors");
  return { errors: remaining.length, remaining };
};`;
  // typed number check: a string "0" would route to the off-map label and hard-fail
  const GATE = `export default async (i) => ({ branch: typeof i.errors !== "number" ? "not-a-number" : i.errors === 0 ? "clean" : "dirty" });`;
  const cat = catalog([agentMd("fixer", ["fixed"]), agentMd("closer")]);

  // NOTE: parsed without the authoring validator (it rejects ${{flow.input.x}} â see e2e-faux-code-steps.test.ts ENGINE BUG).
  const flow = () => parseFlowYamlString(YAML, "<e2e-code>");

  it("converges: 4 issues, the fixer clears 2 then 1 then 1 â three fix passes, then the report", async () => {
    const t = tracker();
    const plan = ["E1,E2", "E1,E2,E3", "E1,E2,E3,E4"]; // cumulative fixed list per pass
    let reportTask = "";
    const fixTasks: string[] = [];
    const result = await runFauxFlow({
      flow: flow(), agents: cat.agents,
      flowInput: { issues: ["E1", "E2", "E3", "E4"] },
      codeHandlers: { lint: LINT, gate: GATE },
      responder: (task) => {
        const m = /FIX pass (\d+)/.exec(task);
        if (m) { fixTasks.push(task); return ok(`fixed batch ${m[1]}`, { fixed: plan[Number(m[1]) - 1] }); }
        reportTask = task;
        return ok("reported");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });

    expect(result.status).toBe("success");
    expect(t.count("fix")).toBe(3);
    expect(t.count("lint")).toBe(3);
    expect(fixTasks.map((x) => /pass (\d+\/\d+)/.exec(x)![1])).toEqual(["1/4", "2/4", "3/4"]);
    expect(result.results.lint.outputs).toEqual({ errors: 0, remaining: [] });
    expect(result.results.lint.summary).toBe("0 lint errors");
    expect(reportTask).toBe("Task: REPORT errors=0 remaining=[]");
  });

  it("never converges: the cap forces the exit after max_iterations loop-backs and the report shows what is left", async () => {
    const t = tracker();
    let reportTask = "";
    const result = await runFauxFlow({
      flow: flow(), agents: cat.agents,
      flowInput: { issues: ["E1", "E2", "E3"] },
      codeHandlers: { lint: LINT, gate: GATE },
      responder: (task) => {
        if (/FIX/.test(task)) return ok("tried", { fixed: "E1" });
        reportTask = task;
        return ok("reported");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });

    expect(result.status).toBe("success");
    expect(t.count("fix")).toBe(5); // 1 + max_iterations (4)
    expect(t.count("gate")).toBe(5);
    expect(reportTask).toBe('Task: REPORT errors=2 remaining=["E2","E3"]');
  });
});

// ââ 6. Realistic: validate an agent's JSON, loop back on invalid ââââââââââ

describe("e2e code steps realistic: validate agent JSON with code, loop back on invalid", () => {
  const YAML = `name: extract-json
description: extractor emits JSON, code validates, loop back with feedback
steps:
  - id: extract
    type: agent
    agent: extractor
    task: "EXTRACT attempt \${{loop.validate.iteration}} feedback=[\${{result.validate.error}}] from \${{task}}"
  - id: validate
    type: code-decision
    blockedBy: [extract]
    inputs:
      raw: "\${{result.extract.payload}}"
    outputs:
      - name: parsed
      - name: error
    branches:
      invalid: extract
      valid: publish
    max_iterations: 2
  - id: quarantine
    type: agent
    agent: closer
    blockedBy: [validate]
    task: "QUARANTINE last error: \${{result.validate.error}}"
  - id: publish
    type: agent
    agent: closer
    task: "PUBLISH \${{result.validate.parsed}}"
  - id: persist
    type: code
    blockedBy: [publish]
    inputs:
      record: "\${{result.validate.parsed}}"
    outputs:
      - name: row
`;
  const VALIDATE = `export default async (i) => {
  let obj;
  try { obj = JSON.parse(i.raw); } catch (e) { return { branch: "invalid", parsed: null, error: "not JSON" }; }
  if (typeof obj.name !== "string") return { branch: "invalid", parsed: null, error: "missing name" };
  if (typeof obj.price !== "number") return { branch: "invalid", parsed: null, error: "price must be a number" };
  return { branch: "valid", parsed: obj, error: "" };
};`;
  const PERSIST = `export default async (i) => ({ row: [i.record.name, i.record.price * 100, typeof i.record] });`;
  const cat = catalog([agentMd("extractor", ["payload"]), agentMd("closer")]);

  it("invalid â loop back with feedback â valid: the parsed object flows on typed (code) and as JSON (agent); quarantine is skipped", async () => {
    const t = tracker();
    const extractTasks: string[] = [];
    const tasks: Record<string, string> = {};
    const attempts = ['{"name": "Widget", "price": "12.50"', '{"name": "Widget", "price": "12.50"}', '{"name": "Widget", "price": 12.5}'];
    const result = await runFauxFlow({
      flow: load(YAML, cat.byName), agents: cat.agents, task: "invoice.pdf",
      codeHandlers: { validate: VALIDATE, persist: PERSIST },
      responder: (task) => {
        const m = /EXTRACT attempt (\d+)/.exec(task);
        if (m) { extractTasks.push(task); return ok("extracted", { payload: attempts[Number(m[1]) - 1] }); }
        tasks[/^Task: (\w+)/.exec(task)![1]] = task;
        return ok("ok");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });

    expect(result.status).toBe("success");
    expect(t.count("extract")).toBe(3);
    expect(extractTasks[0]).toBe("Task: EXTRACT attempt 1 feedback=[] from invoice.pdf");
    expect(extractTasks[1]).toBe("Task: EXTRACT attempt 2 feedback=[not JSON] from invoice.pdf");
    expect(extractTasks[2]).toBe("Task: EXTRACT attempt 3 feedback=[price must be a number] from invoice.pdf");
    // routing node outputs reflect the last (valid) iteration
    expect(result.results.validate.outputs).toEqual({ parsed: { name: "Widget", price: 12.5 }, error: "" });
    expect(tasks.PUBLISH).toBe('Task: PUBLISH {"name":"Widget","price":12.5}');
    expect(result.results.persist.outputs.row).toEqual(["Widget", 1250, "object"]);
    // the forward branch skipped the step in between
    expect(t.started("quarantine")).toBe(false);
  });

  it("valid on the first attempt: no loop-back at all", async () => {
    const t = tracker();
    const result = await runFauxFlow({
      flow: load(YAML, cat.byName), agents: cat.agents,
      codeHandlers: { validate: VALIDATE, persist: PERSIST },
      responder: (task) => (/EXTRACT/.test(task) ? ok("extracted", { payload: '{"name":"Bolt","price":2}' }) : ok("ok")),
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(result.status).toBe("success");
    expect(t.count("extract")).toBe(1);
    expect(t.count("validate")).toBe(1);
    expect(result.results.persist.outputs.row).toEqual(["Bolt", 200, "object"]);
  });

  it("never valid: after max_iterations loop-backs control falls through to the next step in file order (quarantine)", async () => {
    const t = tracker();
    let quarantineTask = "";
    const result = await runFauxFlow({
      flow: load(YAML, cat.byName), agents: cat.agents,
      codeHandlers: { validate: VALIDATE, persist: PERSIST },
      responder: (task) => {
        if (/EXTRACT/.test(task)) return ok("extracted", { payload: "sorry, I could not read the invoice" });
        if (/QUARANTINE/.test(task)) quarantineTask = task;
        return ok("ok");
      },
      onAgentStarted: t.onAgentStarted, onAgentComplete: t.onAgentComplete,
    });
    expect(t.count("extract")).toBe(3); // 1 + max_iterations (2)
    expect(t.count("validate")).toBe(3);
    expect(t.started("quarantine")).toBe(true);
    expect(quarantineTask).toBe("Task: QUARANTINE last error: not JSON");
    expect(result.results.validate.outputs).toEqual({ parsed: null, error: "not JSON" });
  });
});
