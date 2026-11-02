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
    const userFlow = putFlow(agentDir, "u", "f");
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
