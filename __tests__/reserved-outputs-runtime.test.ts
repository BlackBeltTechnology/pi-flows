/**
 * Reserved agent output names must be caught for agents that never went
 * through flow_agents (hand-edited, copied, package agents): a discovery
 * warning, and a refused flow start before any agent runs.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { discoverAll } from "../extensions/flow-engine/discovery.js";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

describe("discovery warns about reserved output names", () => {
  it("loads the agent but warns naming agent, field and outcome", () => {
    const project = mkdtempSync(join(tmpdir(), "res-proj-"));
    const pkg = mkdtempSync(join(tmpdir(), "res-pkg-"));
    mkdirSync(join(project, ".pi", "flows", "agents"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "flows", "agents", "applier.md"),
      "---\nname: applier\ndescription: d\ntools: read\noutputs:\n  - name: status\n  - name: handoff\n---\n\nbody\n",
    );
    const r = discoverAll(pkg, project);
    expect(r.agents.has("applier")).toBe(true);
    const w = r.warnings.find((x) => x.includes("applier"));
    expect(w, JSON.stringify(r.warnings)).toBeDefined();
    expect(w).toContain("status");
    expect(w).toContain("outcome");
  });
});

describe("flow start refuses agents with reserved output names", () => {
  const flow = (steps: FlowConfig["steps"]): FlowConfig => ({ name: "f", description: "d", source: "<faux>", steps });

  it("an agent step whose agent declares `status` fails before any agent runs", async () => {
    let spawned = 0;
    const result = await runFaux({
      flow: flow([{ stepType: "agent", id: "a", agent: "applier", task: "t" }]),
      agents: [makeAgent({ name: "applier", outputs: [{ name: "status" }, { name: "handoff" }] as never })],
      responder: () => { spawned++; return scriptFinish({ status: "complete", summary: "x" }); },
    });
    expect(result.status).toBe("error");
    expect(spawned).toBe(0);
    const msg = result.lastResult?.result.summary ?? "";
    expect(msg).toContain("applier");
    expect(msg).toContain("status");
    expect(msg).toContain("outcome");
  });

  it("a decision agent declaring `branch` fails before any agent runs", async () => {
    let spawned = 0;
    const result = await runFaux({
      flow: flow([
        { stepType: "agent-decision", id: "d", agent: "router", task: "t", branches: { x: "e" } } as never,
        { stepType: "agent", id: "e", agent: "ok", task: "t" },
      ]),
      agents: [
        makeAgent({ name: "router", outputs: [{ name: "branch" }] as never }),
        makeAgent({ name: "ok" }),
      ],
      responder: () => { spawned++; return scriptFinish({ status: "complete", summary: "x" }); },
    });
    expect(result.status).toBe("error");
    expect(spawned).toBe(0);
    expect(result.lastResult?.result.summary ?? "").toContain("branch");
  });

  it("agents with normal outputs still run", async () => {
    const result = await runFaux({
      flow: flow([{ stepType: "agent", id: "a", agent: "applier", task: "t" }]),
      agents: [makeAgent({ name: "applier", outputs: [{ name: "outcome" }] as never })],
      responder: () => scriptFinish({ status: "complete", summary: "x", outcome: "done" }),
    });
    expect(result.status).not.toBe("error");
  });
});
