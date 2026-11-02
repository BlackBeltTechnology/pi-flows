/**
 * Review-fix tests for change `global-flow-location`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { init, getExtraFlowsDirs } from "../extensions/flow-engine/index.js";
import { activate as activateContext } from "../extensions/flow-context/index.js";

const FLOW = "name: x\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: a\n";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
function putFlow(flowsRoot: string, ns: string, name: string) {
  const d = join(flowsRoot, "flows", ns, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "flow.yaml"), FLOW, "utf8");
  return d;
}

describe("flow:delete-request event (G1)", () => {
  let project: string, agentDir: string, pkg: string, extra: string;
  let savedEnv: string | undefined;
  beforeEach(() => {
    project = tmp("rf-proj-");
    agentDir = tmp("rf-agent-");
    pkg = tmp("rf-pkg-");
    extra = tmp("rf-extra-");
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

  function setup() {
    const handlers = new Map<string, (d: any) => void>();
    const emitted: Array<[string, any]> = [];
    const pi: any = {
      events: {
        on: (c: string, h: any) => handlers.set(c, h),
        emit: (c: string, d: any) => emitted.push([c, d]),
      },
      registerTool: () => {},
      registerCommand: () => {},
      on: () => {},
    };
    activateContext(pi);
    return { handlers, emitted };
  }

  it("refuses built-in and package flows, deletes user flows", () => {
    const builtin = putFlow(pkg, "b", "f");
    const pkgFlow = join(extra, "p", "f");
    mkdirSync(pkgFlow, { recursive: true });
    writeFileSync(join(pkgFlow, "flow.yaml"), FLOW, "utf8");
    const userFlow = putFlow(join(agentDir, "flows"), "u", "f");
    getExtraFlowsDirs().push(extra);
    init(pkg, project);

    const { handlers, emitted } = setup();
    const h = handlers.get("flow:delete-request")!;

    h({ flowName: "b:f" });
    h({ flowName: "p:f" });
    expect(existsSync(builtin)).toBe(true);
    expect(existsSync(pkgFlow)).toBe(true);
    const notices = emitted.filter(([c]) => c === "flow:notify").map(([, d]) => d.message);
    expect(notices.some((m: string) => /built-in/.test(m))).toBe(true);
    expect(notices.some((m: string) => /package/.test(m))).toBe(true);

    h({ flowName: "u:f" });
    expect(existsSync(userFlow)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G2 — name/namespace sanitisation in flow_write / flow_agents
// ---------------------------------------------------------------------------
import { registerFlowWriteTool } from "../extensions/flow-engine/tools/flow-write.js";
import { registerFlowAgentsTool } from "../extensions/flow-engine/tools/flow-agents.js";
import { readdirSync } from "node:fs";
import type { AgentConfig } from "../extensions/flow-engine/types.js";

function mkPi() {
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    getAllTools: () => [{ name: "read" }],
    events: { emit: () => {} },
  };
  return { pi, tools };
}
const call = async (t: any, p: unknown) => JSON.parse((await t.execute("1", p, undefined, undefined, {})).content[0].text);
const agentMd = (name: string) => `---\nname: ${name}\ndescription: d\nmodel: "@coding"\ntools: read\n---\n\n# System Prompt\n\nhi\n`;

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

describe("name sanitisation (G2)", () => {
  const bad = ["../../x", "a/b", "A", "-x", "", "x y", ".."];

  for (const scope of ["project", "user"] as const) {
    it(`flow_write rejects bad name/namespace (${scope})`, async () => {
      const root = tmp("g2-root-");
      const project = join(root, "project");
      const user = join(root, "user", "flows");
      mkdirSync(project, { recursive: true });
      const { pi, tools } = mkPi();
      registerFlowWriteTool(pi, () => new Map<string, AgentConfig>([["a", { name: "a" } as AgentConfig]]), project, user);
      const t = tools.get("flow_write");
      for (const b of bad) {
        const r1 = await call(t, { namespace: "ok", name: b, content: FLOW, scope });
        expect(r1.written, `name ${JSON.stringify(b)}`).toBe(false);
        expect(r1.error ?? JSON.stringify(r1.diagnostics)).toMatch(/\[a-z0-9\]/);
        if (b === "") continue; // empty namespace falls back to "custom"
        const r2 = await call(t, { namespace: b, name: "ok", content: FLOW, scope });
        expect(r2.written, `namespace ${JSON.stringify(b)}`).toBe(false);
      }
      expect(allFiles(root)).toEqual([]);
      const good = await call(t, { namespace: "my-ns", name: "f1", content: FLOW, scope });
      expect(good.written).toBe(true);
    });

    it(`flow_agents rejects bad agent name (${scope})`, async () => {
      const root = tmp("g2-root-");
      const project = join(root, "project");
      const user = join(root, "user", "flows");
      mkdirSync(project, { recursive: true });
      const { pi, tools } = mkPi();
      registerFlowAgentsTool(pi, () => new Map(), project, root, () => [], user);
      const t = tools.get("flow_agents");
      for (const b of ["../../x", "a/b", "A", "-x", "x y"]) {
        const r = await call(t, { op: "write", content: agentMd(JSON.stringify(b)), scope });
        expect(r.written, `name ${b}`).toBe(false);
      }
      expect(allFiles(root).filter((f) => !f.includes("node_modules"))).toEqual([]);
      const good = await call(t, { op: "write", content: agentMd("good-agent"), scope });
      expect(good.written).toBe(true);
    });
  }
});
