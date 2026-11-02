/**
 * Review-fix tests for change `resolver-agnostic-model-refs`.
 */
import { describe, expect, it } from "vitest";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";

const md = (modelLines: string) => `---\nname: a\ndescription: d\n${modelLines}tools: read\n---\n\nbody\n`;
const errors = (c: string) => validateAgentContent(c).diagnostics.filter((d) => d.severity === "error");

describe("R1 — ':suffix' that is not a thinking level", () => {
  it("literal ids with a colon (ollama/llama3:8b, openrouter/x:free) are not errors", () => {
    for (const m of ["ollama/llama3:8b", "openrouter/x:free"]) {
      const r = validateAgentContent(md(`model: ${m}\n`));
      expect(errors(md(`model: ${m}\n`)), m).toEqual([]);
      expect(r.valid, m).toBe(true);
    }
  });

  it("an @role with a bad thinking suffix is an error", () => {
    const e = errors(md("model: @fast:bogus\n"));
    expect(e.length).toBe(1);
    expect(e[0].message).toContain("bogus");
    expect(validateAgentContent(md("model: @fast:bogus\n")).valid).toBe(false);
    expect(errors(md("model: @fast:high\n"))).toEqual([]);
  });

  it("spec scenario: literal :extreme still yields a diagnostic naming the level and valid levels", () => {
    const d = validateAgentContent(md("model: anthropic/claude-haiku-4-5:extreme\n")).diagnostics;
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].message).toContain("extreme");
    expect(d.map((x) => x.message + (x.suggestion ?? "")).join(" ")).toContain("xhigh");
  });
});

// ---------------------------------------------------------------------------
// R2 — "no session model" error carries the resolver's reasons
// ---------------------------------------------------------------------------
import { resolveAgentModel } from "../extensions/flow-engine/model-roles.js";

describe("R2 — no session model keeps resolver detail", () => {
  it("includes probe.error, agent name and source", () => {
    const pi: any = {
      events: { emit: (c: string, p: any) => { if (c === "model:resolve") p.error = 'Role "@fast" is not assigned'; } },
    };
    let msg = "";
    try {
      resolveAgentModel(pi, { name: "reviewer", source: "/x/reviewer.md", modelRefs: ["@fast"] }, {});
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("reviewer");
    expect(msg).toContain("/x/reviewer.md");
    expect(msg).toContain('Role "@fast" is not assigned');
    expect(msg).toMatch(/session model/);
  });
});

// ---------------------------------------------------------------------------
// Missing coverage: flow:agent-started payload via the flow-tui emit path, and
// the real built-in flow-decision agent running on the parent model.
// ---------------------------------------------------------------------------
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";
import { parseAgentFile } from "../extensions/flow-engine/agent-parser.js";
import { runFaux, makeAgent, scriptFinish } from "./faux-harness.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

const oneStep: FlowConfig = {
  name: "f", description: "d", source: "<t>",
  steps: [{ stepType: "agent", id: "a", agent: "w", task: "go" }],
};

describe("flow:agent-started payload (emit path)", () => {
  it("carries the requested ref, the used model and the fallback reason", async () => {
    const emitted: Array<{ ch: string; data: any }> = [];
    const pi: any = { events: { emit: (ch: string, data: any) => emitted.push({ ch, data }) } };
    const obs = new EventEmitObserver(pi);
    const agent = makeAgent({ name: "w", model: "@fast", modelRefs: ["@fast"] });
    const r = await runFaux({
      flow: oneStep,
      agents: [agent],
      responder: () => scriptFinish({ status: "complete", summary: "ok" }),
      onAgentStarted: (name, stepId, resolvedModel, extra) => obs.onAgentStarted(name, stepId, agent, resolvedModel, extra),
    });
    expect(r.results.a.status).toBe("complete");
    const withModel = emitted.filter((e) => e.ch === "flow:agent-started" && e.data.stepId === "a" && e.data.resolvedModel);
    expect(withModel.length).toBeGreaterThan(0);
    const data = withModel[0].data;
    expect(data.resolvedModel).toBe("faux/faux-1");
    expect(data.modelFallback).toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "no-resolver" });
  });
});

describe("built-in flow-decision agent (parsed from disk)", () => {
  it("runs without a model:resolve handler on the parent model", async () => {
    const builtin = parseAgentFile(join(fileURLToPath(new URL("..", import.meta.url)), "agents", "flow-decision.md"));
    expect(builtin.name).toBe("flow-decision");
    const flow: FlowConfig = {
      name: "f", description: "d", source: "<t>",
      steps: [
        { stepType: "fork", id: "fk", question: "q?", options: ["yes"], branches: { yes: "next" } },
        { stepType: "agent", id: "next", agent: "worker", task: "n" },
      ],
    };
    const used: Array<string | undefined> = [];
    const r = await runFaux({
      flow,
      agents: [builtin, makeAgent({ name: "worker" })],
      responder: () => scriptFinish({ status: "complete", summary: "d", branch: "yes" }),
      isAutonomous: () => true,
      onAgentStarted: (name, _s, resolvedModel) => { if (name === "flow-decision" && resolvedModel) used.push(resolvedModel); },
    });
    expect(r.results.next.status).toBe("complete");
    expect(used).toEqual(["faux/faux-1"]);
  });
});
