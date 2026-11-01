/**
 * Tests for change `global-flow-location`: user-level flows/agents tier,
 * precedence, source labels, execution context, authoring scope, deletion.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

import { discoverAll, classifySource } from "../extensions/flow-engine/discovery.js";
import { registerFlowAgentsTool } from "../extensions/flow-engine/tools/flow-agents.js";
import { registerFlowWriteTool } from "../extensions/flow-engine/tools/flow-write.js";
import { listFlowEntries, deleteRefusal, deleteConfirmation } from "../extensions/flow-context/index.js";
import { runFaux, makeAgent } from "./faux-harness.js";
import type { AgentConfig, FlowConfig } from "../extensions/flow-engine/types.js";

const FLOW = "name: x\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: a\n";
const agentMd = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\nmodel: "@coding"\ntools: read\n---\n\n# System Prompt\n\nhi\n`;

function tmp(p: string) {
  return mkdtempSync(join(tmpdir(), p));
}
function putFlow(flowsRoot: string, ns: string, name: string, body = FLOW) {
  const d = join(flowsRoot, "flows", ns, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "flow.yaml"), body, "utf8");
  return join(d, "flow.yaml");
}
function putAgent(flowsRoot: string, name: string, desc: string) {
  const d = join(flowsRoot, "agents");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${name}.md`), agentMd(name, desc), "utf8");
}

let project: string, user: string, pkg: string;
beforeEach(() => {
  project = tmp("ufl-proj-");
  user = join(tmp("ufl-agent-"), "flows");
  pkg = tmp("ufl-pkg-");
});

describe("discovery — user tier", () => {
  it("discovers a user flow and agent; missing user dir is silent", () => {
    putFlow(user, "batch", "apply");
    putAgent(user, "reviewer", "r");
    const res = discoverAll(pkg, project, [], [], user);
    expect(res.flows.has("batch:apply")).toBe(true);
    expect(res.agents.has("reviewer")).toBe(true);
    const none = discoverAll(pkg, project, [], [], join(tmp("ufl-none-"), "flows"));
    expect(none.warnings).toEqual([]);
    expect(none.flows.size).toBe(0);
  });

  it("precedence: project > user > package > built-in", () => {
    const extra = tmp("ufl-extra-");
    putFlow(extra, "n", "f"); // extra flows dir layout: <root>/<ns>/<name>/flow.yaml
    const extraFlows = join(extra, "flows");
    putAgent(pkg, "dup", "builtin");
    mkdirSync(join(pkg, "agents"), { recursive: true });
    writeFileSync(join(pkg, "agents", "dup.md"), agentMd("dup", "builtin"));
    putAgent(user, "dup", "user");
    let res = discoverAll(pkg, project, [], [extraFlows], user);
    expect(res.agents.get("dup")!.description).toBe("user");

    putFlow(user, "n", "f");
    res = discoverAll(pkg, project, [], [extraFlows], user);
    expect(classifySource(res.flows.get("n:f")!.source, { projectRoot: project, userRoot: user, extraDirs: [extraFlows] })).toBe("user");

    putFlow(join(project, ".pi", "flows"), "n", "f");
    putAgent(join(project, ".pi", "flows"), "dup", "project");
    res = discoverAll(pkg, project, [], [extraFlows], user);
    expect(classifySource(res.flows.get("n:f")!.source, { projectRoot: project, userRoot: user })).toBe("project");
    expect(res.agents.get("dup")!.description).toBe("project");
  });
});

describe("classifySource", () => {
  it("returns project | user | package | built-in", () => {
    const roots = { projectRoot: "/p", userRoot: "/u/flows", extraDirs: ["/x"] };
    expect(classifySource("/p/.pi/flows/flows/a/b/flow.yaml", roots)).toBe("project");
    expect(classifySource("/u/flows/agents/a.md", roots)).toBe("user");
    expect(classifySource("/x/a/flow.yaml", roots)).toBe("package");
    expect(classifySource("/pkg/agents/a.md", roots)).toBe("built-in");
    expect(classifySource(undefined, roots)).toBe("built-in");
  });
});

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

describe("authoring scope", () => {
  it("flow_write scope user writes under user root; default project; invalid rejected", async () => {
    const { pi, tools, emitted } = mkPi();
    registerFlowWriteTool(pi, () => new Map<string, AgentConfig>([["a", { name: "a" } as AgentConfig]]), project, user);
    const t = tools.get("flow_write");
    const u = await call(t, { namespace: "batch", name: "apply", content: FLOW, scope: "user" });
    expect(u.written).toBe(true);
    expect(existsSync(join(user, "flows", "batch", "apply", "flow.yaml"))).toBe(true);
    expect(emitted).toContain("flow:rediscover");
    const d = await call(t, { namespace: "batch", name: "apply", content: FLOW });
    expect(d.path).toBe(join(project, ".pi", "flows", "flows", "batch", "apply", "flow.yaml"));
    const bad = await call(t, { name: "z", content: FLOW, scope: "global" });
    expect(bad.written).toBe(false);
    expect(bad.error).toMatch(/project.*user/);
    expect(existsSync(join(project, ".pi", "flows", "flows", "custom", "z"))).toBe(false);
    expect(existsSync(join(user, "flows", "custom", "z"))).toBe(false);
  });

  it("flow_agents write scope user + list labels source", async () => {
    const { pi, tools } = mkPi();
    const agents = new Map<string, AgentConfig>();
    registerFlowAgentsTool(pi, () => agents, project, pkg, () => [], user);
    const t = tools.get("flow_agents");
    const w = await call(t, { op: "write", content: agentMd("ua", "u"), scope: "user" });
    expect(w.written).toBe(true);
    expect(w.path).toBe(join(user, "agents", "ua.md"));
    const d = await call(t, { op: "write", content: agentMd("pa", "p") });
    expect(d.path).toBe(join(project, ".pi", "flows", "agents", "pa.md"));
    const bad = await call(t, { op: "write", content: agentMd("ba", "b"), scope: "global" });
    expect(bad.written).toBe(false);
    expect(existsSync(join(user, "agents", "ba.md"))).toBe(false);
    agents.set("ua", { name: "ua", description: "u", tools: [], source: w.path } as unknown as AgentConfig);
    const list = await call(t, { op: "list" });
    expect(list[0].source_type).toBe("user");
  });
});

describe("delete", () => {
  it("user flow deletable, confirmation names path; package/built-in refused", () => {
    const src = putFlow(user, "batch", "apply");
    const flows = new Map<string, FlowConfig>([
      ["batch:apply", { name: "batch:apply", source: src } as FlowConfig],
      ["p:f", { name: "p:f", source: "/x/f/flow.yaml" } as FlowConfig],
      ["b:f", { name: "b:f", source: "/pkg/flows/f/flow.yaml" } as FlowConfig],
    ]);
    const es = listFlowEntries(flows, { projectRoot: project, userRoot: user, extraDirs: ["/x"] });
    const byName = Object.fromEntries(es.map((e) => [e.name, e]));
    expect(byName["batch:apply"].source).toBe("user");
    expect(deleteRefusal(byName["batch:apply"])).toBeNull();
    expect(deleteConfirmation(byName["batch:apply"])).toContain(join(user, "flows", "batch", "apply"));
    expect(deleteRefusal(byName["p:f"])).toMatch(/package/);
    expect(deleteRefusal(byName["b:f"])).toMatch(/built-in/);
  });
});

describe("execution context", () => {
  it("user flow loads handler from its own dir; ctx.cwd is the project", async () => {
    const src = putFlow(user, "batch", "apply");
    writeFileSync(
      join(user, "flows", "batch", "apply", "load.ts"),
      `export default async function h(_i, ctx) { ctx.setSummary("cwd=" + ctx.cwd); return {}; }\n`,
    );
    const flow: FlowConfig = {
      name: "batch:apply",
      description: "d",
      source: src,
      steps: [{ stepType: "code", id: "load" } as any],
    };
    const r = await runFaux({ flow, agents: [makeAgent({ name: "a" })], responder: () => { throw new Error("no agent"); }, cwd: project });
    expect(r.results.load.status).toBe("complete");
    expect(r.results.load.summary).toContain(`cwd=${project}`);
  });
});
