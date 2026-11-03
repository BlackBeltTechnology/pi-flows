/**
 * Reserved agent output names: finish-tool fields (`status`, `summary`, `files`,
 * `artifacts`) are never valid declared outputs; `branch` is reserved for
 * decision agents.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import type { AgentConfig } from "../extensions/flow-engine/types.js";

const agentMd = (outputs: string) =>
  `---\nname: a\ndescription: d\ntools: read\n${outputs}---\n\n\${{task}}\n`;
const errs = (c: string) => validateAgentContent(c).diagnostics.filter((d) => d.severity === "error");

describe("reserved output names — agent validation", () => {
  for (const name of ["status", "summary", "files", "artifacts"]) {
    it(`inline list: ${name} is an error naming the field and suggesting outcome`, () => {
      const e = errs(agentMd(`outputs: [${name}]\n`));
      expect(e).toHaveLength(1);
      expect(e[0].message).toContain(name);
      expect(e[0].suggestion).toContain("outcome");
    });
  }

  it("block list and expanded form are checked too", () => {
    expect(errs(agentMd("outputs:\n  - status\n")).map((d) => d.message).join()).toContain("status");
    expect(errs(agentMd("outputs:\n  - name: summary\n    description: x\n")).map((d) => d.message).join()).toContain("summary");
  });

  it("`outcome` is fine", () => {
    expect(errs(agentMd("outputs: [outcome]\n"))).toEqual([]);
    expect(errs(agentMd("outputs:\n  - name: outcome\n"))).toEqual([]);
  });

  it("`branch` is NOT an error on a plain agent (only decision agents)", () => {
    expect(errs(agentMd("outputs: [branch]\n"))).toEqual([]);
  });

  it("no shipped agent trips the reserved-output check", () => {
    const dir = join(__dirname, "..", "agents");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const r = validateAgentContent(readFileSync(join(dir, f), "utf-8"));
      expect(r.diagnostics.filter((d) => /reserved/i.test(d.message)), f).toEqual([]);
    }
  });
});

describe("reserved output `branch` — flow validation of decision agents", () => {
  const catalog = (): Map<string, AgentConfig> =>
    new Map([
      ["judge", parseAgentString(agentMd("outputs:\n  - branch\n").replace("name: a", "name: judge"), "judge")],
      ["worker", parseAgentString(agentMd("outputs:\n  - branch\n").replace("name: a", "name: worker"), "worker")],
    ]);
  const flowErrors = (yaml: string) =>
    validateFlowContent(yaml, catalog).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

  it("agent-decision agent declaring `branch` errors, suggesting outcome", () => {
    const m = flowErrors(`name: f
description: d
steps:
  - id: gate
    type: agent-decision
    agent: judge
    task: "go"
    branches:
      done: fin
      fix: fin
  - id: fin
    type: agent
    agent: worker
`);
    expect(m.some((x) => x.includes("judge") && x.includes("branch") && /reserved/.test(x))).toBe(true);
    expect(m.some((x) => x.includes("worker") && x.includes("branch"))).toBe(false);
  });

  it("decision_agent declaring `branch` errors", () => {
    const m = flowErrors(`name: f
description: d
decision_agent: judge
steps:
  - id: fin
    type: agent
    agent: worker
`);
    expect(m.some((x) => x.includes("judge") && x.includes("branch"))).toBe(true);
  });
});
