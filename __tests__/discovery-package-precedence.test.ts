/**
 * Discovery precedence: project > user > package (registered dirs) > built-in.
 * A registered package dir must override a same-named pi-flows built-in.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { discoverAll, classifySource } from "../extensions/flow-engine/discovery.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const agentMd = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\ntools: read\n---\n\nhi\n`;
const flowYaml = (desc: string) =>
  `name: x\ndescription: ${desc}\nsteps:\n  - id: s\n    type: agent\n    agent: a\n`;

function layout() {
  const builtin = tmp("prec-builtin-");
  const extraAgents = tmp("prec-extra-agents-");
  const extraFlows = tmp("prec-extra-flows-");
  const project = tmp("prec-proj-");
  mkdirSync(join(builtin, "agents"), { recursive: true });
  writeFileSync(join(builtin, "agents", "same.md"), agentMd("same", "builtin"));
  mkdirSync(join(builtin, "flows", "ns", "same"), { recursive: true });
  writeFileSync(join(builtin, "flows", "ns", "same", "flow.yaml"), flowYaml("builtin"));
  writeFileSync(join(extraAgents, "same.md"), agentMd("same", "package"));
  mkdirSync(join(extraFlows, "ns", "same"), { recursive: true });
  writeFileSync(join(extraFlows, "ns", "same", "flow.yaml"), flowYaml("package"));
  return { builtin, extraAgents, extraFlows, project };
}

describe("discovery precedence: package over built-in", () => {
  it("a same-named agent in a registered package dir wins over the built-in", () => {
    const l = layout();
    const r = discoverAll(l.builtin, l.project, [l.extraAgents], [l.extraFlows]);
    expect(r.agents.get("same")?.description).toBe("package");
  });

  it("a same-named flow in a registered package dir wins over the built-in", () => {
    const l = layout();
    const r = discoverAll(l.builtin, l.project, [l.extraAgents], [l.extraFlows]);
    expect(r.flows.get("ns:same")?.description).toBe("package");
  });

  it("user and project still beat the package", () => {
    const l = layout();
    const user = tmp("prec-user-");
    mkdirSync(join(user, "agents"), { recursive: true });
    writeFileSync(join(user, "agents", "same.md"), agentMd("same", "user"));
    expect(discoverAll(l.builtin, l.project, [l.extraAgents], [l.extraFlows], user).agents.get("same")?.description).toBe("user");
    mkdirSync(join(l.project, ".pi", "flows", "agents"), { recursive: true });
    writeFileSync(join(l.project, ".pi", "flows", "agents", "same.md"), agentMd("same", "project"));
    expect(discoverAll(l.builtin, l.project, [l.extraAgents], [l.extraFlows], user).agents.get("same")?.description).toBe("project");
  });

  it("classifySource labels the winning (package) file as package", () => {
    const l = layout();
    const r = discoverAll(l.builtin, l.project, [l.extraAgents], [l.extraFlows]);
    const roots = { projectRoot: l.project, extraDirs: [l.extraAgents, l.extraFlows] };
    expect(classifySource(r.agents.get("same")?.source, roots)).toBe("package");
    expect(classifySource(r.flows.get("ns:same")?.source, roots)).toBe("package");
    expect(classifySource(join(l.builtin, "agents", "same.md"), roots)).toBe("built-in");
  });
});
