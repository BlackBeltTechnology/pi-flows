/**
 * End-to-end faux scenarios for user-scope flows (change: global-flow-location).
 *
 * Everything lives in temp dirs (user root, project, package roots) — never the
 * real ~/.pi. Flows/agents are authored the way a user writes them (YAML +
 * markdown + a code handler), discovered with `discoverAll(..., userRoot)`,
 * then run from a SEPARATE project cwd on the real runFlow via the faux model.
 *
 * Behaviour under test is the spec (openspec/changes/global-flow-location):
 *  - user flows run with handlers loaded from their own bundle, ctx.cwd = project
 *  - precedence project > user > package > built-in (flows AND agents)
 *  - flow_write / flow_agents `scope: "user"` write under <agentDir>/flows/
 *  - /flows:delete deletes user flows, refuses package/built-in flows
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifySource, discoverAll } from "../extensions/flow-engine/discovery.js";
import { registerFlowAgentsTool } from "../extensions/flow-engine/tools/flow-agents.js";
import { registerFlowWriteTool } from "../extensions/flow-engine/tools/flow-write.js";
import { getExtraFlowsDirs, init } from "../extensions/flow-engine/index.js";
import { activate as activateContext, deleteRefusal, listFlowEntries } from "../extensions/flow-context/index.js";
import type { AgentConfig } from "../extensions/flow-engine/types.js";
import { runFaux, scriptFinish } from "./faux-harness.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- fixtures ---------------------------------------------------------------

const agentMd = (name: string, opts: { model?: string; outputs?: string[]; desc?: string } = {}) =>
  `---\nname: ${name}\ndescription: ${opts.desc ?? `${name} agent`}\nmodel: ${opts.model ?? "faux/faux-1"}\ntools: read\n` +
  (opts.outputs ? `outputs:\n${opts.outputs.map((o) => `  - name: ${o}\n`).join("")}` : "") +
  `---\n\nYou are ${name}.\n`;

const ok = (summary: string, extra: Record<string, unknown> = {}) => scriptFinish({ status: "complete", summary, ...extra });

let root: string, userRoot: string, project: string, pkg: string, extraPkg: string;
const dirs: string[] = [];
function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  root = tmp("e2e-uf-");
  userRoot = join(root, "agent", "flows"); // <agentDir>/flows
  project = join(root, "project");
  pkg = join(root, "pkg"); // stands in for the built-in package root
  extraPkg = join(root, "extra"); // a registered package's flows/agents dirs
  for (const d of [project, pkg]) mkdirSync(d, { recursive: true });
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function put(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
  return file;
}
const flowFile = (rootDir: string, ns: string, name: string) => join(rootDir, "flows", ns, name, "flow.yaml");

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? allFiles(p) : [p];
  });
}

// ---- 1. user bundle runs in a separate project ------------------------------

describe("e2e faux user flows: a user bundle discovered via userRoot", () => {
  const FLOW = `name: apply
description: user-level batch apply
steps:
  - id: load-plan
    type: code
    outputs:
      - name: cwd
      - name: handlerUrl
      - name: items
  - id: review
    type: agent
    agent: user-reviewer
    blockedBy: [load-plan]
    task: "REVIEW \${{result.load-plan.items}} in \${{result.load-plan.cwd}}"
    inputs:
      plan: "\${{result.load-plan.summary}}"
  - id: report
    type: agent
    agent: user-reporter
    blockedBy: [review]
    task: "REPORT \${{result.review.verdict}}"
`;
  const HANDLER = `export default async function handler(_input, ctx) {
  ctx.setSummary("plan loaded for " + ctx.flowName);
  return { cwd: ctx.cwd, handlerUrl: import.meta.url, items: ["a", "b"] };
}
`;

  function writeBundle() {
    const flowYaml = put(flowFile(userRoot, "batch", "apply"), FLOW);
    put(join(dirname(flowYaml), "load-plan.ts"), HANDLER);
    put(join(userRoot, "agents", "user-reviewer.md"), agentMd("user-reviewer", { outputs: ["verdict"] }));
    put(join(userRoot, "agents", "user-reporter.md"), agentMd("user-reporter"));
    return flowYaml;
  }

  it("is discovered, labelled `user`, and its project has no .pi/flows at all", () => {
    const flowYaml = writeBundle();
    const res = discoverAll(pkg, project, [], [], userRoot);
    expect(res.warnings).toEqual([]);
    expect([...res.flows.keys()]).toEqual(["batch:apply"]);
    expect(res.flows.get("batch:apply")!.source).toBe(flowYaml);
    expect(res.agents.has("user-reviewer")).toBe(true);
    expect(classifySource(res.flows.get("batch:apply")!.source, { projectRoot: project, userRoot })).toBe("user");
    expect(existsSync(join(project, ".pi"))).toBe(false);
  });

  it("runs from a separate project: handler from the user bundle, ctx.cwd = project, outputs wired", async () => {
    const flowYaml = writeBundle();
    const res = discoverAll(pkg, project, [], [], userRoot);
    const tasks: Record<string, string> = {};
    const started: string[] = [];

    const result = await runFaux({
      flow: res.flows.get("batch:apply")!,
      agents: [...res.agents.values()],
      cwd: project,
      maxTurns: 12,
      responder: (task) => {
        if (/REVIEW/.test(task)) { tasks.review = task; return ok("reviewed", { verdict: "LGTM" }); }
        if (/REPORT/.test(task)) { tasks.report = task; return ok("reported"); }
        return ok("default");
      },
      onAgentStarted: (name, step) => started.push(`${step}:${name}`),
    });

    expect(result.status).toBe("success");

    // Code handler: loaded from the user bundle dir, executed against the PROJECT.
    const load = result.results["load-plan"];
    expect(load.status).toBe("complete");
    expect(load.summary).toBe("plan loaded for batch:apply");
    expect(load.outputs.cwd).toBe(project);
    expect(String(load.outputs.handlerUrl)).toContain(join(dirname(flowYaml), "load-plan.ts"));
    expect(load.outputs.items).toEqual(["a", "b"]);

    // User agents ran, in order, and outputs were wired through the templates.
    expect(started).toEqual(["load-plan:load-plan", "review:user-reviewer", "report:user-reporter"]);
    expect(tasks.review).toContain(`in ${project}`);
    expect(tasks.review).toContain('["a","b"]');
    expect(result.results.review.outputs.verdict).toBe("LGTM");
    expect(tasks.report).toContain("REPORT LGTM");

    // Nothing was written into the user bundle or project by running.
    expect(existsSync(join(userRoot, "results"))).toBe(false);
  });

  it("an explicit `target:` handler inside the user bundle (.mjs) is honoured too", async () => {
    const dir = dirname(flowFile(userRoot, "batch", "apply"));
    put(join(dir, "helpers", "double.mjs"), "export default async (i, ctx) => ({ out: i.n * 2, where: ctx.cwd });");
    const yaml = `name: apply
description: d
steps:
  - id: calc
    type: code
    target: ${join(dir, "helpers", "double.mjs")}
    inputs:
      n: "21"
    outputs:
      - name: out
      - name: where
`;
    put(flowFile(userRoot, "batch", "apply"), yaml);
    const res = discoverAll(pkg, project, [], [], userRoot);
    const result = await runFaux({
      flow: res.flows.get("batch:apply")!, agents: [], cwd: project,
      responder: () => { throw new Error("no agent expected"); },
    });
    expect(result.results.calc.status).toBe("complete");
    expect(Number(result.results.calc.outputs.out)).toBe(42);
    expect(result.results.calc.outputs.where).toBe(project);
  });
});

// ---- 2/3. precedence at run time --------------------------------------------

describe("e2e faux user flows: precedence is honoured at run time", () => {
  const flowYaml = (marker: string) => `name: apply
description: ${marker}
steps:
  - id: do
    type: agent
    agent: worker
    task: "${marker} \${{task}}"
`;

  it("project flow and user flow with the same name → the project one runs", async () => {
    put(flowFile(userRoot, "batch", "apply"), flowYaml("USER-FLOW"));
    put(flowFile(join(project, ".pi", "flows"), "batch", "apply"), flowYaml("PROJECT-FLOW"));
    put(join(userRoot, "agents", "worker.md"), agentMd("worker"));

    const res = discoverAll(pkg, project, [], [], userRoot);
    const flow = res.flows.get("batch:apply")!;
    expect(classifySource(flow.source, { projectRoot: project, userRoot })).toBe("project");

    const tasks: string[] = [];
    const result = await runFaux({
      flow, agents: [...res.agents.values()], cwd: project, maxTurns: 6,
      responder: (t) => { tasks.push(t); return ok("done"); },
    });
    expect(result.status).toBe("success");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toContain("PROJECT-FLOW");
    expect(tasks[0]).not.toContain("USER-FLOW");

    // Without the project flow the user flow takes over.
    rmSync(join(project, ".pi"), { recursive: true });
    const res2 = discoverAll(pkg, project, [], [], userRoot);
    tasks.length = 0;
    await runFaux({
      flow: res2.flows.get("batch:apply")!, agents: [...res2.agents.values()], cwd: project, maxTurns: 6,
      responder: (t) => { tasks.push(t); return ok("done"); },
    });
    expect(tasks[0]).toContain("USER-FLOW");
  });

  it("a user agent named like the built-in `flow-decision` is the one the decision uses", async () => {
    const decisionFlow = `name: gate
description: decision without an agent
steps:
  - id: gate
    type: agent-decision
    task: "DECIDE"
    branches:
      go: publish
      stop: park
  - id: publish
    type: agent
    agent: worker
    task: "PUBLISH"
  - id: park
    type: agent
    agent: worker
    task: "PARK"
`;
    put(flowFile(userRoot, "ops", "gate"), decisionFlow);
    put(join(userRoot, "agents", "worker.md"), agentMd("worker"));
    const run = async (withUserOverride: boolean) => {
      if (withUserOverride) {
        // The real built-in declares `model: @fast`; the override pins the literal faux model.
        put(join(userRoot, "agents", "flow-decision.md"), agentMd("flow-decision", { desc: "USER OVERRIDE" }));
      }
      const res = discoverAll(REPO_ROOT, project, [], [], userRoot);
      const extras: any[] = [];
      const result = await runFaux({
        flow: res.flows.get("ops:gate")!, agents: [...res.agents.values()], cwd: project, maxTurns: 12,
        responder: (t) => (/DECIDE/.test(t) ? ok("decided", { branch: "go" }) : ok("ran")),
        onAgentStarted: (name, step, _m, extra) => { if (step === "gate") extras.push({ name, extra }); },
      });
      return { res, result, extras };
    };

    const builtin = await run(false);
    expect(builtin.res.agents.get("flow-decision")!.description).not.toBe("USER OVERRIDE");
    expect(builtin.result.status).toBe("success");
    // built-in `@fast` has no resolver here → reported fallback to the session model.
    expect(builtin.extras[0].name).toBe("flow-decision");
    expect(builtin.extras[0].extra.modelFallback?.requested).toEqual(["@fast"]);

    const user = await run(true);
    const agent = user.res.agents.get("flow-decision")!;
    expect(agent.description).toBe("USER OVERRIDE");
    expect(classifySource(agent.source, { projectRoot: project, userRoot })).toBe("user");
    expect(user.result.status).toBe("success");
    expect(user.result.results.publish.status).toBe("complete");
    expect(user.result.results.park.status).toBe("skipped");
    // The user agent (literal faux/faux-1) ran the decision: no fallback was needed.
    expect(user.extras[0].name).toBe("flow-decision");
    expect(user.extras[0].extra.modelFallback).toBeUndefined();
  });

  it("a registered package agent overrides the built-in agent of the same name at run time", async () => {
    // built-in tier (pkg root): `dup` without a verdict output, on an unresolvable role
    put(join(pkg, "agents", "dup.md"), agentMd("dup", { model: "@coding", desc: "BUILT-IN" }));
    // package tier (registered dir): same name, declares `verdict`, literal model
    put(join(extraPkg, "agents", "dup.md"), agentMd("dup", { outputs: ["verdict"], desc: "PACKAGE" }));
    put(flowFile(extraPkg, "pk", "run"), `name: run
description: package flow
steps:
  - id: s
    type: agent
    agent: dup
    task: "GO"
`);

    const res = discoverAll(pkg, project, [join(extraPkg, "agents")], [join(extraPkg, "flows")], userRoot);
    expect(res.agents.get("dup")!.description).toBe("PACKAGE");
    expect(classifySource(res.flows.get("pk:run")!.source, { projectRoot: project, userRoot, extraDirs: [join(extraPkg, "flows")] })).toBe("package");

    const started: any[] = [];
    const result = await runFaux({
      flow: res.flows.get("pk:run")!, agents: [...res.agents.values()], cwd: project, maxTurns: 6,
      responder: () => ok("packaged", { verdict: "from-package" }),
      onAgentStarted: (_n, step, _m, extra) => started.push({ step, extra }),
    });
    expect(result.status).toBe("success");
    // typed output only exists on the package agent's contract
    expect(result.results.s.outputs.verdict).toBe("from-package");
    expect(started[0].extra.modelFallback).toBeUndefined();

    // …and a user agent in turn beats the package one.
    put(join(userRoot, "agents", "dup.md"), agentMd("dup", { outputs: ["verdict"], desc: "USER" }));
    const res2 = discoverAll(pkg, project, [join(extraPkg, "agents")], [join(extraPkg, "flows")], userRoot);
    expect(res2.agents.get("dup")!.description).toBe("USER");
  });
});

// ---- 4. authoring tools with scope "user" -----------------------------------

function mkPi() {
  const tools = new Map<string, any>();
  const emitted: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    getAllTools: () => [{ name: "read" }],
    events: { emit: (c: string) => emitted.push(c) },
  };
  return { pi, tools, emitted };
}
const call = async (t: any, p: unknown) => JSON.parse((await t.execute("1", p, undefined, undefined, {})).content[0].text);

describe("e2e faux user flows: flow_agents / flow_write with scope \"user\"", () => {
  it("writes agents + flow into the user root; discovery finds them; the flow runs end-to-end", async () => {
    const { pi, tools, emitted } = mkPi();
    const live = () => discoverAll(pkg, project, [], [], userRoot).agents;
    registerFlowAgentsTool(pi, live, project, pkg, () => [], userRoot);
    registerFlowWriteTool(pi, live, project, userRoot);

    // 1. author the agent (user scope)
    const a = await call(tools.get("flow_agents"), { op: "write", scope: "user", content: agentMd("scribe", { outputs: ["doc"] }) });
    expect(a).toMatchObject({ written: true, path: join(userRoot, "agents", "scribe.md") });

    // 2. author the flow (user scope) that uses it, plus a code step
    const flowContent = `name: draft
description: authored by the tools
steps:
  - id: prep
    type: code
    outputs:
      - name: topic
  - id: write
    type: agent
    agent: scribe
    blockedBy: [prep]
    task: "WRITE about \${{result.prep.topic}} in \${{task}}"
`;
    const w = await call(tools.get("flow_write"), { namespace: "docs", name: "draft", scope: "user", content: flowContent });
    expect(w.written).toBe(true);
    expect(w.command).toBe("docs:draft");
    expect(w.path).toBe(flowFile(userRoot, "docs", "draft"));
    expect(readFileSync(w.path, "utf8")).toBe(flowContent);
    expect(emitted).toContain("flow:rediscover");
    // scaffold for the code step lands beside the flow in the user bundle, never in the project
    expect(w.generatedHandlers.map((p: string) => p.replace(userRoot, "<user>"))).toEqual(["<user>/flows/docs/draft/prep.ts.default"]);
    expect(allFiles(project)).toEqual([]);

    // 3. the user "implements" the handler next to flow.yaml, then discovery picks everything up
    put(join(dirname(w.path), "prep.ts"), `export default async (_i, ctx) => ({ topic: "widgets@" + ctx.cwd.split("/").pop() });`);
    const res = discoverAll(pkg, project, [], [], userRoot);
    expect(res.flows.has("docs:draft")).toBe(true);
    expect(res.agents.has("scribe")).toBe(true);

    // 4. run it from the project
    let task = "";
    const result = await runFaux({
      flow: res.flows.get("docs:draft")!, agents: [...res.agents.values()], cwd: project, maxTurns: 6, task: "the handbook",
      responder: (t) => { task = t; return ok("written", { doc: "DOC-1" }); },
    });
    expect(result.status).toBe("success");
    expect(task).toContain("WRITE about widgets@project in the handbook");
    expect(result.results.write.outputs.doc).toBe("DOC-1");
  });

  it("default scope still writes into the project, not the user root", async () => {
    const { pi, tools } = mkPi();
    registerFlowAgentsTool(pi, () => new Map(), project, pkg, () => [], userRoot);
    const a = await call(tools.get("flow_agents"), { op: "write", content: agentMd("pa") });
    expect(a.path).toBe(join(project, ".pi", "flows", "agents", "pa.md"));
    expect(allFiles(userRoot)).toEqual([]);
  });

  it("unsafe names and an invalid scope are rejected and nothing is written", async () => {
    const { pi, tools } = mkPi();
    registerFlowWriteTool(pi, () => new Map<string, AgentConfig>([["a", { name: "a" } as AgentConfig]]), project, userRoot);
    registerFlowAgentsTool(pi, () => new Map(), project, pkg, () => [], userRoot);
    const FLOW = "name: x\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: a\n";

    for (const bad of ["../../escape", "a/b", "A", "-x", "x y", ".."]) {
      const byName = await call(tools.get("flow_write"), { namespace: "ok", name: bad, content: FLOW, scope: "user" });
      expect(byName.written, `name ${bad}`).toBe(false);
      const byNs = await call(tools.get("flow_write"), { namespace: bad, name: "ok", content: FLOW, scope: "user" });
      expect(byNs.written, `namespace ${bad}`).toBe(false);
      const agent = await call(tools.get("flow_agents"), { op: "write", scope: "user", content: agentMd(JSON.stringify(bad)) });
      expect(agent.written, `agent ${bad}`).toBe(false);
    }
    const badScope = await call(tools.get("flow_write"), { name: "z", content: FLOW, scope: "global" });
    expect(badScope.written).toBe(false);
    expect(badScope.error).toMatch(/"project", "user"/);
    const badAgentScope = await call(tools.get("flow_agents"), { op: "write", scope: "global", content: agentMd("zz") });
    expect(badAgentScope.written).toBe(false);

    // Nothing anywhere under the temp root except the (empty) dirs we created ourselves.
    expect(allFiles(root)).toEqual([]);
    expect(existsSync(userRoot)).toBe(false);
  });
});

// ---- 5. deletion ------------------------------------------------------------

describe("e2e faux user flows: deleting flows", () => {
  const FLOW = "name: x\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: a\n";

  it("helpers: user flow is deletable (confirmation names its dir); package and built-in are refused", () => {
    const userSrc = put(flowFile(userRoot, "u", "f"), FLOW);
    const pkgSrc = put(join(extraPkg, "p", "f", "flow.yaml"), FLOW);
    const builtinSrc = put(flowFile(pkg, "b", "f"), FLOW);
    const res = discoverAll(pkg, project, [], [extraPkg], userRoot);
    const entries = Object.fromEntries(
      listFlowEntries(res.flows, { projectRoot: project, userRoot, extraDirs: [extraPkg] }).map((e) => [e.name, e]),
    );
    expect(entries["u:f"].source).toBe("user");
    expect(entries["p:f"].source).toBe("package");
    expect(entries["b:f"].source).toBe("built-in");
    expect(deleteRefusal(entries["u:f"])).toBeNull();
    expect(deleteRefusal(entries["p:f"])).toMatch(/package/);
    expect(deleteRefusal(entries["b:f"])).toMatch(/built-in/);
    for (const f of [userSrc, pkgSrc, builtinSrc]) expect(existsSync(f)).toBe(true);
  });

  describe("flow:delete-request event", () => {
    let agentDir: string;
    let savedEnv: string | undefined;
    beforeEach(() => {
      agentDir = join(root, "agent");
      savedEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      vi.spyOn(process, "cwd").mockReturnValue(project);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedEnv;
      getExtraFlowsDirs().length = 0;
    });

    it("deletes a user flow (and it is gone from discovery); refuses built-in and package flows", () => {
      const builtinDir = dirname(put(flowFile(pkg, "b", "f"), FLOW));
      const pkgDir = dirname(put(join(extraPkg, "p", "f", "flow.yaml"), FLOW));
      const userDir = dirname(put(flowFile(userRoot, "u", "f"), FLOW));
      getExtraFlowsDirs().push(extraPkg);
      init(pkg, project);

      const handlers = new Map<string, (d: any) => void>();
      const emitted: Array<[string, any]> = [];
      const pi: any = {
        events: { on: (c: string, h: any) => handlers.set(c, h), emit: (c: string, d: any) => emitted.push([c, d]) },
        registerTool: () => {}, registerCommand: () => {}, on: () => {},
      };
      activateContext(pi);
      const del = handlers.get("flow:delete-request")!;

      del({ flowName: "b:f" });
      del({ flowName: "p:f" });
      expect(existsSync(builtinDir)).toBe(true);
      expect(existsSync(pkgDir)).toBe(true);
      const notices = emitted.filter(([c]) => c === "flow:notify").map(([, d]) => d.message as string);
      expect(notices.some((m) => /built-in/.test(m))).toBe(true);
      expect(notices.some((m) => /package/.test(m))).toBe(true);
      expect(existsSync(userDir)).toBe(true);

      del({ flowName: "u:f" });
      expect(existsSync(userDir)).toBe(false);
      expect(existsSync(builtinDir) && existsSync(pkgDir)).toBe(true);
      expect(discoverAll(pkg, project, [], [extraPkg], userRoot).flows.has("u:f")).toBe(false);
    });
  });
});
