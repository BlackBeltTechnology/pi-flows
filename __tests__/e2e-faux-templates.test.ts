/**
 * End-to-end faux scenarios for template expansion (docs/flows.md "Template
 * Variable Reference", "Typed Flow Inputs", "Routing Node Semantics", "Loops",
 * "Decider chain → Decision agent"). Flows are authored as YAML + agent
 * markdown, validated where the references are meant to be valid, parsed, and
 * run on the real runFlow with the faux provider (runFauxFlow).
 *
 * Observable surface: the dispatched task text each agent receives (the
 * responder's input), the question an interactive fork asks, the input object
 * a code handler receives (echoed back as a declared output), and step results.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { runFauxFlow, scriptFinish, type FinishArgs, type RunFauxFlowOptions } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";

// ── authoring helpers ──────────────────────────────────────────────────────

const agentMd = (name: string, outputs = "") =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n${outputs}---\n\nYou are ${name}.\n`;

const BASE_MDS = [
  agentMd("worker"),
  agentMd("judge"),
  agentMd("producer", "outputs:\n  - name: title\n  - name: count\n    type: number\n"),
  agentMd("shadow", "outputs:\n  - name: fullOutput\n"),
];

function author(yaml: string, mds: string[] = BASE_MDS, check = true) {
  const agents = mds.map((m) => parseAgentString(m, "<tpl>"));
  if (check) {
    const byName = new Map(agents.map((a) => [a.name, a]));
    const diag = validateFlowContent(yaml, () => byName, () => true);
    const errors = diag.diagnostics.filter((d) => d.severity === "error");
    expect(errors, yaml).toEqual([]);
  }
  return { flow: parseFlowYamlString(yaml, "<tpl>"), agents };
}

const ok = (summary: string, extra: Record<string, unknown> = {}) => scriptFinish({ status: "complete", summary, ...extra });

/** An assistant turn with reply prose AND a finish call (the prose becomes the step's fullOutput). */
const say = (text: string, args: FinishArgs) => {
  const { status, summary, ...rest } = args;
  return fauxAssistantMessage([fauxText(text), fauxToolCall("finish", { status, summary, files: [], ...rest })]);
};

/** Echo the handler's whole input object back as a declared `echo` output (JSON-typed). */
const ECHO = `export default async (input) => ({ echo: input });`;

type Opts = Omit<RunFauxFlowOptions, "flow" | "agents" | "responder">;

/** Run a flow, recording every dispatched task; `on` maps a marker to a response. */
async function run(
  yaml: string,
  on: (t: string) => ReturnType<typeof ok> | undefined,
  opts: Opts & { mds?: string[]; check?: boolean } = {},
) {
  const { flow, agents } = author(yaml, opts.mds, opts.check ?? true);
  const tasks: string[] = [];
  const result = await runFauxFlow({
    flow, agents, maxTurns: 64, ...opts,
    responder: (t) => { tasks.push(t); return on(t) ?? ok("default"); },
  });
  /** The (single) task containing `marker`. */
  const task = (marker: string) => {
    const hits = tasks.filter((t) => t.includes(marker));
    expect(hits, `one task with ${marker}`).toHaveLength(1);
    return hits[0];
  };
  return { result, tasks, task, all: (marker: string) => tasks.filter((t) => t.includes(marker)) };
}

// ── ${{task}} ──────────────────────────────────────────────────────────────

describe("e2e faux templates: ${{task}}", () => {
  const YAML = `name: t-task
description: task everywhere
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA do [\${{task}}] then again [\${{task}}]"
  - id: c
    type: code
    blockedBy: [a]
    inputs:
      whole: "\${{task}}"
      emb: "about \${{task}}!"
    outputs:
      - name: echo
`;

  it("expands (every occurrence) in an agent task and in code inputs", async () => {
    const { result, task } = await run(YAML, () => ok("done"), { task: "build the widget", codeHandlers: { c: ECHO } });
    expect(result.status).toBe("success");
    expect(task("AAA")).toContain("AAA do [build the widget] then again [build the widget]");
    expect(result.results.c.outputs.echo).toEqual({ whole: "build the widget", emb: "about build the widget!" });
  });

  it("a task containing `$` replacement patterns ($&, $$, $1) arrives verbatim", async () => {
    const raw = "pay $$5 for $& and $1";
    const { task } = await run(YAML, () => ok("done"), { task: raw, codeHandlers: { c: ECHO } });
    expect(task("AAA")).toContain(`do [${raw}]`);
  });
});

// ── ${{flow.input.x}} ──────────────────────────────────────────────────────

describe("e2e faux templates: ${{flow.input.x}}", () => {
  const YAML = `name: t-input
description: typed flow inputs in text and in code
inputs:
  name: { type: string, required: true }
  count: { type: number }
  flag: { type: boolean }
  cfg: { type: object }
  tags: { type: array }
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA name=\${{flow.input.name}} count=\${{flow.input.count}} flag=\${{flow.input.flag}} cfg=\${{flow.input.cfg}} tags=\${{flow.input.tags}}"
  - id: c
    type: code
    blockedBy: [a]
    inputs:
      cfg: "\${{flow.input.cfg}}"
      count: "\${{flow.input.count}}"
      tags: "\${{flow.input.tags}}"
      flag: "\${{flow.input.flag}}"
      cfgText: "cfg is \${{flow.input.cfg}}"
      countText: "n=\${{flow.input.count}}"
    outputs:
      - name: echo
`;

  it("the validator accepts a declared ${{flow.input.x}} reference", () => {
    const byName = new Map(BASE_MDS.map((m) => { const a = parseAgentString(m, "<tpl>"); return [a.name, a]; }));
    const errs = validateFlowContent(YAML, () => byName, () => true).diagnostics.filter((d) => d.severity === "error");
    expect(errs).toEqual([]);
  });

  it("strings, numbers and booleans render as text; objects and arrays as compact JSON", async () => {
    const { result, task } = await run(YAML, () => ok("done"), {
      codeHandlers: { c: ECHO },
      flowInput: { name: "Ada", count: 3, flag: false, cfg: { a: 1, b: [true, "x"] }, tags: ["p1", 2] },
    });
    expect(result.status).toBe("success");
    expect(task("AAA")).toContain('AAA name=Ada count=3 flag=false cfg={"a":1,"b":[true,"x"]} tags=["p1",2]');
  });

  it("a whole-value code input receives the real JSON type; an embedded one the serialized text", async () => {
    const { result } = await run(YAML, () => ok("done"), {
      codeHandlers: { c: ECHO },
      flowInput: { name: "Ada", count: 3, flag: true, cfg: { a: 1, nested: { z: null } }, tags: ["p1"] },
    });
    expect(result.results.c.outputs.echo).toEqual({
      cfg: { a: 1, nested: { z: null } },
      count: 3,
      tags: ["p1"],
      flag: true,
      cfgText: 'cfg is {"a":1,"nested":{"z":null}}',
      countText: "n=3",
    });
  });

  it("an optional input that was not provided expands to the empty string (text and code)", async () => {
    const { result, task } = await run(YAML, () => ok("done"), { codeHandlers: { c: ECHO }, flowInput: { name: "Ada" } });
    expect(result.status).toBe("success");
    const t = task("AAA");
    expect(t).toContain("AAA name=Ada count= flag= cfg= tags=");
    expect(t).not.toMatch(/undefined|null/);
    expect(result.results.c.outputs.echo).toMatchObject({ cfg: "", count: "", cfgText: "cfg is ", countText: "n=" });
  });
});

// ── ${{result.x.<field>}} ──────────────────────────────────────────────────

describe("e2e faux templates: result fields", () => {
  const YAML = `name: t-result
description: standard result fields
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA write a haiku"
  - id: b
    type: agent
    agent: worker
    blockedBy: [a]
    task: "BBB sum=[\${{result.a.summary}}] st=[\${{result.a.status}}] full=[\${{result.a.fullOutput}}] bare=[\${{result.a}}]"
  - id: c
    type: code
    blockedBy: [a]
    inputs:
      full: "\${{result.a.fullOutput}}"
      bare: "\${{result.a}}"
      sum: "\${{result.a.summary}}"
      st: "\${{result.a.status}}"
      emb: "<\${{result.a.fullOutput}}|\${{result.a.summary}}>"
    outputs:
      - name: echo
`;
  const HAIKU = "rain on the tin roof\nthe kettle starts to whisper\nnobody answers";

  it("summary is the finish summary; fullOutput and bare refs are the reply text; status is the finish status", async () => {
    const { result, task } = await run(YAML, (t) => (/AAA/.test(t) ? say(HAIKU, { status: "complete", summary: "Wrote a haiku about rain" }) : undefined), { codeHandlers: { c: ECHO } });
    expect(result.status).toBe("success");
    expect(task("BBB")).toContain(`BBB sum=[Wrote a haiku about rain] st=[complete] full=[${HAIKU}] bare=[${HAIKU}]`);
  });

  it("code inputs: whole-value standard fields arrive as strings; embedded refs interpolate", async () => {
    const { result } = await run(YAML, (t) => (/AAA/.test(t) ? say(HAIKU, { status: "complete", summary: "Wrote a haiku" }) : undefined), { codeHandlers: { c: ECHO } });
    expect(result.results.c.outputs.echo).toEqual({
      full: HAIKU, bare: HAIKU, sum: "Wrote a haiku", st: "complete", emb: `<${HAIKU}|Wrote a haiku>`,
    });
  });

  it("an agent that only calls finish (no prose) has an empty fullOutput — never its summary or 'undefined'", async () => {
    const { task } = await run(YAML, (t) => (/AAA/.test(t) ? ok("only a summary") : undefined), { codeHandlers: { c: ECHO } });
    const t = task("BBB");
    expect(t).toContain("sum=[only a summary]");
    expect(t).not.toContain("undefined");
    expect(t).toContain("full=[");
    expect(t).not.toContain("full=[only a summary]");
  });

  it("${{result.x.status}} reports a soft failure ('error' / 'blocked') to the on_error target", async () => {
    const yaml = (status: string) => `name: t-status-${status}
description: status of a failed step
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA risky"
    on_error: rescue
  - id: next
    type: agent
    agent: worker
    blockedBy: [a]
    task: "NEXT"
  - id: rescue
    type: agent
    agent: worker
    blockedBy: [a]
    task: "RESCUE st=[\${{result.a.status}}] sum=[\${{result.a.summary}}]"
`;
    for (const status of ["error", "blocked"] as const) {
      const { result, task } = await run(yaml(status), (t) => (/AAA/.test(t) ? scriptFinish({ status, summary: `gave up ${status}` }) : undefined));
      expect(result.results.next.status).toBe("skipped");
      expect(task("RESCUE")).toContain(`RESCUE st=[${status}] sum=[gave up ${status}]`);
    }
  });

  it("an on_error target ordered only by the on_error edge (no blockedBy) sees the failed step's result", async () => {
    const yaml = `name: t-onerror-order
description: on_error edge as the only ordering
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA risky"
    on_error: rescue
  - id: rescue
    type: agent
    agent: worker
    task: "RESCUE st=[\${{result.a.status}}] sum=[\${{result.a.summary}}]"
`;
    const { task } = await run(yaml, (t) => (/AAA/.test(t) ? scriptFinish({ status: "error", summary: "boom" }) : undefined));
    expect(task("RESCUE")).toContain("RESCUE st=[error] sum=[boom]");
  });

  it("a declared output named fullOutput wins over the reply text in task templates", async () => {
    const yaml = `name: t-shadow
description: declared fullOutput
steps:
  - id: s
    type: agent
    agent: shadow
    task: "SSS"
  - id: b
    type: agent
    agent: worker
    blockedBy: [s]
    task: "BBB full=[\${{result.s.fullOutput}}] bare=[\${{result.s}}]"
`;
    const { result, task } = await run(yaml, (t) => (/SSS/.test(t) ? say("the prose reply", { status: "complete", summary: "s", fullOutput: "DECLARED-VALUE" }) : undefined));
    expect(result.status).toBe("success");
    expect(result.results.s.outputs.fullOutput).toBe("DECLARED-VALUE");
    expect(task("BBB")).toContain("full=[DECLARED-VALUE]");
    // the bare reference is documented as the agent's full raw output
    expect(task("BBB")).toContain("bare=[the prose reply]");
  });

  it("a declared output named fullOutput also wins as a whole-value code input", async () => {
    const yaml = `name: t-shadow-code
description: declared fullOutput into code
steps:
  - id: s
    type: agent
    agent: shadow
    task: "SSS"
  - id: c
    type: code
    blockedBy: [s]
    inputs:
      whole: "\${{result.s.fullOutput}}"
      emb: "x \${{result.s.fullOutput}}"
    outputs:
      - name: echo
`;
    const { result } = await run(yaml, (t) => (/SSS/.test(t) ? say("the prose reply", { status: "complete", summary: "s", fullOutput: "DECLARED-VALUE" }) : undefined), { codeHandlers: { c: ECHO } });
    expect((result.results.c.outputs.echo as any).emb).toBe("x DECLARED-VALUE");
    expect((result.results.c.outputs.echo as any).whole).toBe("DECLARED-VALUE");
  });
});

// ── typed declared outputs ────────────────────────────────────────────────

describe("e2e faux templates: typed declared outputs", () => {
  it("agent outputs (string, number) render in downstream text", async () => {
    const yaml = `name: t-typed-agent
description: agent declared outputs
steps:
  - id: p
    type: agent
    agent: producer
    task: "PPP"
  - id: b
    type: agent
    agent: worker
    blockedBy: [p]
    task: "BBB title=[\${{result.p.title}}] count=[\${{result.p.count}}] twice=[\${{result.p.title}}/\${{result.p.title}}]"
`;
    const { result, task } = await run(yaml, (t) => (/PPP/.test(t) ? ok("produced", { title: "Widget Plan", count: "7" }) : undefined));
    expect(result.status).toBe("success");
    expect(task("BBB")).toContain("BBB title=[Widget Plan] count=[7] twice=[Widget Plan/Widget Plan]");
    expect(Number(result.results.p.outputs.count)).toBe(7);
  });

  it("code outputs of every JSON type: compact JSON in agent text, real types to a downstream handler", async () => {
    const yaml = `name: t-typed-code
description: code outputs of every type
steps:
  - id: gen
    type: code
    outputs:
      - name: obj
      - name: arr
      - name: num
      - name: bool
      - name: str
      - name: nil
  - id: b
    type: agent
    agent: worker
    blockedBy: [gen]
    task: "BBB obj=\${{result.gen.obj}} arr=\${{result.gen.arr}} num=\${{result.gen.num}} bool=\${{result.gen.bool}} str=\${{result.gen.str}} nil=[\${{result.gen.nil}}]"
  - id: c
    type: code
    blockedBy: [gen]
    inputs:
      obj: "\${{result.gen.obj}}"
      arr: "\${{result.gen.arr}}"
      num: "\${{result.gen.num}}"
      bool: "\${{result.gen.bool}}"
      objText: "o=\${{result.gen.obj}}"
    outputs:
      - name: echo
`;
    const { result, task } = await run(yaml, () => ok("done"), {
      codeHandlers: {
        gen: `export default async () => ({ obj: { k: "v", n: [1, 2] }, arr: [{ a: 1 }, "b"], num: 4.5, bool: true, str: "plain", nil: null });`,
        c: ECHO,
      },
    });
    expect(result.status).toBe("success");
    expect(task("BBB")).toContain('BBB obj={"k":"v","n":[1,2]} arr=[{"a":1},"b"] num=4.5 bool=true str=plain nil=[]');
    expect(result.results.c.outputs.echo).toEqual({
      obj: { k: "v", n: [1, 2] }, arr: [{ a: 1 }, "b"], num: 4.5, bool: true, objText: 'o={"k":"v","n":[1,2]}',
    });
  });
});

// ── unresolved references ─────────────────────────────────────────────────

describe("e2e faux templates: unresolved references expand to \"\"", () => {
  const ROUTED = `name: t-unresolved
description: refs to an untaken branch
steps:
  - id: route
    type: code-decision
    branches:
      left: left
      right: right
  - id: left
    type: agent
    agent: producer
    task: "LEFT"
  - id: right
    type: agent
    agent: worker
    task: "RIGHT"
  - id: join
    type: agent
    agent: worker
    blockedBy: [left, right]
    task: "JOIN sum=[\${{result.left.summary}}] full=[\${{result.left.fullOutput}}] bare=[\${{result.left}}] title=[\${{result.left.title}}] st=[\${{result.left.status}}] r=[\${{result.right.summary}}]"
  - id: c
    type: code
    blockedBy: [join]
    inputs:
      title: "\${{result.left.title}}"
      sum: "\${{result.left.summary}}"
      bare: "\${{result.left}}"
    outputs:
      - name: echo
`;

  it("an untaken branch: summary/fullOutput/bare/typed output are empty and status is 'skipped' (text and code)", async () => {
    const { result, task } = await run(ROUTED, (t) => (/RIGHT/.test(t) ? ok("went right") : undefined), {
      codeHandlers: { route: `export default async () => ({ branch: "right" });`, c: ECHO },
    });
    expect(result.status).toBe("success");
    expect(result.results.left.status).toBe("skipped");
    expect(task("JOIN")).toContain("JOIN sum=[] full=[] bare=[] title=[] st=[skipped] r=[went right]");
    expect(result.results.c.outputs.echo).toEqual({ title: "", sum: "", bare: "" });
  });

  it("refs that do not resolve at all (undeclared output, unknown step, undeclared ${{input.x}}) expand to \"\" — never 'undefined'", async () => {
    const yaml = `name: t-unknown
description: refs that resolve to nothing (validation deliberately skipped)
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA"
  - id: b
    type: agent
    agent: worker
    blockedBy: [a]
    task: "BBB foo=[\${{result.a.foo}}] ghost=[\${{result.ghost.summary}}] ghostBare=[\${{result.ghost}}] in=[\${{input.nope}}] fi=[\${{flow.input.nope}}]"
`;
    const { result, task } = await run(yaml, () => ok("done"), { check: false });
    expect(result.status).toBe("success");
    const t = task("BBB");
    expect(t).toContain("BBB foo=[] ghost=[] ghostBare=[] in=[] fi=[]");
    expect(t).not.toContain("undefined");
  });

  it("the validator rejects an undeclared output reference ahead of time", () => {
    const yaml = `name: t-bad
description: undeclared field
steps:
  - id: a
    type: agent
    agent: worker
    task: "AAA"
  - id: b
    type: agent
    agent: worker
    blockedBy: [a]
    task: "BBB \${{result.a.foo}}"
`;
    const agents = new Map(BASE_MDS.map((m) => { const a = parseAgentString(m, "<t>"); return [a.name, a]; }));
    const errs = validateFlowContent(yaml, () => agents, () => true).diagnostics.filter((d) => d.severity === "error");
    expect(errs.some((d) => /foo/.test(d.message))).toBe(true);
  });
});

// ── loops ─────────────────────────────────────────────────────────────────

describe("e2e faux templates: loop counters", () => {
  const AGENT_LOOP = `name: t-loop
description: agent-decision loop with counters everywhere
decision_agent: judge
steps:
  - id: draft
    type: agent
    agent: producer
    task: "DRAFT pass \${{loop.gate.iteration}} of \${{loop.gate.max}}"
  - id: gate
    type: agent-decision
    blockedBy: [draft]
    task: "GATE pass \${{loop.gate.iteration}}/\${{loop.gate.max}} title=\${{result.draft.title}}"
    state:
      pass: "\${{loop.gate.iteration}}"
      title: "\${{result.draft.title}}"
    branches:
      again: { to: draft, means: "Needs another draft" }
      done: { to: publish, means: "Good enough" }
    max_iterations: 2
  - id: publish
    type: agent
    agent: worker
    task: "PUBLISH title=[\${{result.draft.title}}] sum=[\${{result.draft.summary}}] full=[\${{result.draft.fullOutput}}] count=[\${{result.draft.count}}] gate=[\${{result.gate.summary}}]"
`;
  const draftAt = (t: string) => Number(/DRAFT pass (\d+)/.exec(t)?.[1]);
  const responder = (doneAt: number) => (t: string) => {
    if (/DRAFT/.test(t)) { const n = draftAt(t); return say(`prose v${n}`, { status: "complete", summary: `draft ${n}`, title: `Title v${n}`, count: String(n * 10) }); }
    if (/GATE/.test(t)) { const n = Number(/GATE pass (\d+)/.exec(t)?.[1]); return ok(`judged ${n}`, { branch: n >= doneAt ? "done" : "again" }); }
    return undefined;
  };

  it("iteration/max in the body, the decision task and the decision state agree pass by pass", async () => {
    const { result, all } = await run(AGENT_LOOP, responder(3), { isAutonomous: () => true });
    expect(result.status).toBe("success");
    expect(all("DRAFT").map((t) => /DRAFT pass (\d+ of \d+)/.exec(t)![1])).toEqual(["1 of 2", "2 of 2", "3 of 2"]);
    const gates = all("GATE pass");
    expect(gates.map((t) => /GATE pass (\d+\/\d+) title=(\S+ v\d)/.exec(t)!.slice(1).join(" "))).toEqual([
      "1/2 Title v1", "2/2 Title v2", "3/2 Title v3",
    ]);
    // The decision agent's expanded state carries this pass's values.
    gates.forEach((t, i) => {
      expect(t).toContain(`State:\n- pass: ${i + 1}\n- title: Title v${i + 1}`);
      expect(t).toContain("Branches (call finish with exactly one of these as `branch`):\n- again: Needs another draft\n- done: Good enough");
    });
  });

  it("a result referenced after the loop reflects the LAST iteration (summary, fullOutput, typed outputs)", async () => {
    const { result, task } = await run(AGENT_LOOP, responder(2), { isAutonomous: () => true });
    expect(result.status).toBe("success");
    expect(task("PUBLISH")).toContain("PUBLISH title=[Title v2] sum=[draft 2] full=[prose v2] count=[20] gate=[judged 2]");
    expect(result.results.draft.summary).toBe("draft 2");
  });

  it("code-decision loop: the counter reaches code inputs and the body; the exit step sees the last pass", async () => {
    const yaml = `name: t-code-loop
description: code-decision loop
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK pass \${{loop.check.iteration}}/\${{loop.check.max}}"
  - id: check
    type: code-decision
    blockedBy: [work]
    inputs:
      it: "\${{loop.check.iteration}}"
      max: "\${{loop.check.max}}"
      last: "\${{result.work.summary}}"
    outputs:
      - name: seen
    branches:
      again: work
      done: finish
    max_iterations: 3
  - id: finish
    type: agent
    agent: worker
    task: "FINISH last=[\${{result.work.summary}}] seen=[\${{result.check.seen}}]"
`;
    const { result, all, task } = await run(yaml, (t) => {
      const m = /WORK pass (\d+)/.exec(t);
      return m ? ok(`worked ${m[1]}`) : undefined;
    }, {
      codeHandlers: { check: `export default async (i) => ({ branch: i.last === "worked 3" ? "done" : "again", seen: i.it + "/" + i.max + ":" + i.last });` },
    });
    expect(result.status).toBe("success");
    expect(all("WORK pass").map((t) => /WORK pass (\S+)/.exec(t)![1])).toEqual(["1/3", "2/3", "3/3"]);
    expect(task("FINISH")).toContain("FINISH last=[worked 3] seen=[3/3:worked 3]");
  });
});

// ── decision tasks, fork questions, state ─────────────────────────────────

describe("e2e faux templates: decisions and forks", () => {
  it("an agent-decision task is expanded, then followed by the branch list and the expanded state", async () => {
    const yaml = `name: t-decide
description: decision task templates
decision_agent: judge
inputs:
  cfg: { type: object }
steps:
  - id: p
    type: agent
    agent: producer
    task: "PPP"
  - id: gate
    type: agent-decision
    blockedBy: [p]
    task: "GATE for \${{task}}: is '\${{result.p.title}}' (\${{result.p.count}}) ok?"
    state:
      title: "\${{result.p.title}}"
      cfg: "\${{flow.input.cfg}}"
      mixed: "\${{result.p.summary}} @ \${{task}}"
    branches:
      yes: { to: ship, means: "The title is acceptable" }
      no: stop
  - id: ship
    type: agent
    agent: worker
    task: "SHIP"
  - id: stop
    type: agent
    agent: worker
    task: "STOP"
`;
    const { result, task } = await run(yaml, (t) => {
      if (/PPP/.test(t)) return ok("produced", { title: "Widget", count: "3" });
      if (/GATE/.test(t)) return ok("yes", { branch: "yes" });
      return undefined;
    }, { task: "the release", flowInput: { cfg: { strict: true } } });
    expect(result.status).toBe("success");
    expect(result.results.ship.status).toBe("complete");
    expect(task("GATE")).toContain(
      "GATE for the release: is 'Widget' (3) ok?\n\n" +
      "Branches (call finish with exactly one of these as `branch`):\n- yes: The title is acceptable\n- no\n\n" +
      'State:\n- title: Widget\n- cfg: {"strict":true}\n- mixed: produced @ the release',
    );
  });

  const FORK = (extra = "") => `name: t-fork
description: fork question templates
inputs:
  env: { type: string }
steps:
  - id: p
    type: agent
    agent: producer
    task: "PPP"
  - id: fk
    type: fork
    blockedBy: [p]
    question: "Deploy '\${{result.p.title}}' for \${{task}} to \${{flow.input.env}}?"
    options: [deploy, hold]
    branches:
      deploy: dep
      hold: hold
${extra}  - id: dep
    type: agent
    agent: worker
    task: "DEP"
  - id: hold
    type: agent
    agent: worker
    task: "HOLD"
`;
  const forkOn = (t: string) => {
    if (/PPP/.test(t)) return ok("produced", { title: "Widget", count: "1" });
    if (/DEP|HOLD/.test(t)) return undefined;
    return ok("picked", { branch: "hold" });
  };

  it("an interactive fork asks the expanded question", async () => {
    const asked: string[] = [];
    const { result } = await run(FORK(), forkOn, {
      task: "v2", flowInput: { env: "prod" }, isAutonomous: () => false,
      askUser: async (q) => { asked.push(q); return { answer: "deploy" }; },
    });
    expect(asked).toEqual(["Deploy 'Widget' for v2 to prod?"]);
    expect(result.results.dep.status).toBe("complete");
  });

  it("an autonomous fork's decision agent sees the expanded question and expanded state", async () => {
    const { result, task } = await run(
      FORK("    state:\n      title: \"${{result.p.title}}\"\n      env: \"${{flow.input.env}}\"\n").replace("description: fork question templates\n", "description: fork question templates\ndecision_agent: judge\n"),
      forkOn,
      { task: "v2", flowInput: { env: "prod" }, isAutonomous: () => true },
    );
    expect(result.results.hold.status).toBe("complete");
    expect(result.results.dep.status).toBe("skipped");
    const t = task("The user was asked");
    expect(t).toContain("Deploy 'Widget' for v2 to prod?");
    expect(t).toContain("Branches (call finish with exactly one of these as `branch`):\n- deploy\n- hold");
    expect(t).toContain("State:\n- title: Widget\n- env: prod");
  });

  it("a fork `task:` is expanded and replaces the question for the decision agent", async () => {
    const { task } = await run(
      FORK("    task: \"FORKTASK pick for ${{result.p.title}} (${{task}})\"\n").replace("description: fork question templates\n", "description: fork question templates\ndecision_agent: judge\n"),
      (t) => (/FORKTASK/.test(t) ? ok("picked", { branch: "deploy" }) : forkOn(t)),
      { task: "v2", flowInput: { env: "prod" }, isAutonomous: () => true },
    );
    const t = task("FORKTASK");
    expect(t).toContain("FORKTASK pick for Widget (v2)");
    expect(t).toContain("- deploy\n- hold");
  });
});
