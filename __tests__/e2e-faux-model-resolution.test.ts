/**
 * End-to-end faux scenarios for model resolution (spec: flow-model-resolution,
 * change resolver-agnostic-model-refs). Flows and agents are authored the way a
 * user writes files (YAML + markdown), validated, parsed, then run on the real
 * runFlow/spawnAgent with the faux provider.
 *
 * Observable surface used here:
 *  - the `model:resolve` probes the engine emits (`resolveHandler`)
 *  - the model each turn is actually served by (responder's 2nd arg)
 *  - `flow:agent-started` payloads (`onAgentStarted` → modelFallback extra)
 *  - which agents spawned (responder calls / started events)
 *  - the step results / flow status
 */
import { describe, expect, it } from "vitest";
import { runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import { makeParentSession, bootExtension, runFlowViaEvent } from "./helpers/parent-session.js";

const agentMd = (name: string, model: string | null) =>
  `---\nname: ${name}\ndescription: ${name} agent\n${model ? `model: ${model}\n` : ""}tools: read\n---\n\nYou are ${name}.\n`;

/** Validate authored files, then parse them. */
function author(flowYaml: string, agentMds: string[]) {
  const agents = agentMds.map((m) => parseAgentString(m, "<e2e>"));
  const byName = new Map(agents.map((a) => [a.name, a]));
  const flowDiag = validateFlowContent(flowYaml, () => byName, () => true);
  expect(flowDiag.diagnostics.filter((d) => d.severity === "error"), "flow validates").toEqual([]);
  for (const md of agentMds) {
    expect(validateAgentContent(md).diagnostics.filter((d) => d.severity === "error"), md).toEqual([]);
  }
  return { flow: parseFlowYamlString(flowYaml, "<e2e>"), agents };
}

/** A handler-supplied Model object (NOT in the session registry). */
const fauxModel = (id: string) => ({
  id, name: id, api: "faux", provider: "faux", baseUrl: "http://faux.invalid", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
});

interface Started { name: string; step: string; model: unknown; extra: any }

/** Task-marker responder that records which agent steps were served by which model id. */
function recorder() {
  const served: Array<{ marker: string; modelId: string }> = [];
  const responder = (task: string, model: any) => {
    const marker = /\b(PLAN|BUILD|REVIEW|RISKY|PUBLISH|RECOVER|WRAPUP|PREP)\b/.exec(task)?.[1] ?? "?";
    served.push({ marker, modelId: model?.id });
    return scriptFinish({ status: "complete", summary: `${marker} done` });
  };
  return { served, responder };
}

const THREE_STEP = `name: three-step
description: plan, build, review
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN \${{task}}"
  - id: build
    type: agent
    agent: builder
    task: "BUILD from \${{result.plan.summary}}"
    blockedBy: [plan]
  - id: review
    type: agent
    agent: reviewer
    task: "REVIEW \${{result.build.summary}}"
    blockedBy: [build]
`;

describe("e2e faux: model:resolve handler", () => {
  it("resolves @fast/@coding to faux models for a 3-step flow; no fallback reported", async () => {
    const { flow, agents } = author(THREE_STEP, [
      agentMd("planner", "@fast"),
      agentMd("builder", "@coding"),
      agentMd("reviewer", "@fast"),
    ]);
    const emitted: string[] = [];
    const { served, responder } = recorder();
    const started: Started[] = [];

    const result = await runFaux({
      flow, agents, responder,
      resolveHandler: (probe) => {
        emitted.push(probe.ref);
        if (probe.ref === "@fast") { probe.model = fauxModel("faux-fast"); probe.resolved = "faux/faux-fast"; }
        if (probe.ref === "@coding") { probe.model = fauxModel("faux-coding"); probe.resolved = "faux/faux-coding"; }
      },
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });

    expect(result.status).toBe("success");
    for (const id of ["plan", "build", "review"]) expect(result.results[id].status).toBe("complete");
    // Wiring still works across the three steps.
    expect(result.results.build.summary).toBe("BUILD done");
    // Each agent ran on the model its role resolved to (not the session model).
    expect(served).toEqual([
      { marker: "PLAN", modelId: "faux-fast" },
      { marker: "BUILD", modelId: "faux-coding" },
      { marker: "REVIEW", modelId: "faux-fast" },
    ]);
    // One emit per ref per step, exactly the authored refs.
    expect(emitted.sort()).toEqual(["@coding", "@fast", "@fast"]);
    // The resolved id is shown on the card and nothing reports a fallback.
    expect(started.map((s) => s.model)).toEqual(["faux/faux-fast", "faux/faux-coding", "faux/faux-fast"]);
    for (const s of started) expect(s.extra?.modelFallback).toBeUndefined();
  });

  it("handler reports @fast as unassigned → session-model fallback (resolver-error); flow completes", async () => {
    const { flow, agents } = author(THREE_STEP, [
      agentMd("planner", "@fast"),
      agentMd("builder", "@coding"),
      agentMd("reviewer", "@fast"),
    ]);
    const { served, responder } = recorder();
    const started: Started[] = [];

    const result = await runFaux({
      flow, agents, responder,
      resolveHandler: (probe) => {
        if (probe.ref === "@fast") probe.error = 'Role "@fast" is not assigned';
        if (probe.ref === "@coding") { probe.model = fauxModel("faux-coding"); probe.resolved = "faux/faux-coding"; }
      },
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });

    expect(result.status).toBe("success");
    expect(Object.values(result.results).every((r) => r.status === "complete")).toBe(true);
    // @fast steps run on the session model, @coding on its resolved model.
    expect(served.map((s) => s.modelId)).toEqual(["faux-1", "faux-coding", "faux-1"]);

    const by = Object.fromEntries(started.map((s) => [s.step, s]));
    expect(by.plan.extra.modelFallback).toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "resolver-error" });
    expect(by.review.extra.modelFallback).toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "resolver-error" });
    expect(by.build.extra?.modelFallback).toBeUndefined();
  });

  it("a flow where nothing resolves still completes on the session model (no resolver, no model declared)", async () => {
    const { flow, agents } = author(THREE_STEP, [
      agentMd("planner", "@fast"),
      agentMd("builder", null),
      agentMd("reviewer", "[@fast, @coding]"),
    ]);
    const { served, responder } = recorder();
    const started: Started[] = [];
    const result = await runFaux({
      flow, agents, responder,
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });
    expect(result.status).toBe("success");
    expect(served.map((s) => s.modelId)).toEqual(["faux-1", "faux-1", "faux-1"]);
    const by = Object.fromEntries(started.map((s) => [s.step, s.extra.modelFallback]));
    expect(by.plan).toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "no-resolver" });
    expect(by.build).toEqual({ requested: [], used: "faux/faux-1", reason: "no-model-declared" });
    expect(by.review).toEqual({ requested: ["@fast", "@coding"], used: "faux/faux-1", reason: "no-resolver" });
  });
});

describe("e2e faux: ordered model lists", () => {
  it("[@missing, faux/faux-1] skips the unresolvable role and uses the literal; no fallback reported", async () => {
    const { flow, agents } = author(THREE_STEP, [
      agentMd("planner", "[@missing, faux/faux-1]"),
      agentMd("builder", "[@missing, faux/faux-1]"),
      agentMd("reviewer", "faux/faux-1"),
    ]);
    const emitted: string[] = [];
    const { served, responder } = recorder();
    const started: Started[] = [];
    const result = await runFaux({
      flow, agents, responder,
      resolveHandler: (probe) => { emitted.push(probe.ref); if (probe.ref === "@missing") probe.error = 'Role "@missing" is not assigned'; },
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });
    expect(result.status).toBe("success");
    expect(served.map((s) => s.modelId)).toEqual(["faux-1", "faux-1", "faux-1"]);
    for (const s of started) expect(s.extra?.modelFallback).toBeUndefined();
    // The role was tried first, then the literal — each entry once per step.
    expect(emitted.filter((r) => r === "@missing")).toHaveLength(2);
    expect(emitted.filter((r) => r === "faux/faux-1")).toHaveLength(3);
  });

  it("a typo'd literal first fails the step (later entries not tried) and on_error routes to recovery", async () => {
    const yaml = `name: typo-list
description: risky step with a typo'd model, recovered via on_error
steps:
  - id: prep
    type: agent
    agent: planner
    task: "PREP \${{task}}"
  - id: risky
    type: agent
    agent: typo-agent
    task: "RISKY work"
    blockedBy: [prep]
    on_error: recover
  - id: publish
    type: agent
    agent: builder
    task: "PUBLISH it"
    blockedBy: [risky]
  - id: recover
    type: agent
    agent: reviewer
    task: "RECOVER from \${{result.prep.summary}}"
    blockedBy: [publish]
`;
    const { flow, agents } = author(yaml, [
      agentMd("planner", "faux/faux-1"),
      agentMd("typo-agent", "[faux/fuax-1, @fast]"),
      agentMd("builder", "faux/faux-1"),
      agentMd("reviewer", "faux/faux-1"),
    ]);
    const emitted: string[] = [];
    const { served, responder } = recorder();
    const result = await runFaux({
      flow, agents, responder,
      resolveHandler: (probe) => { emitted.push(probe.ref); },
    });

    // Flow continues through on_error → recover; publish (between) is skipped.
    expect(result.status).toBe("success");
    expect(result.results.prep.status).toBe("complete");
    expect(result.results.risky.status).not.toBe("complete");
    expect(result.results.risky.summary).toContain("faux/fuax-1");
    expect(result.results.publish.status).toBe("skipped");
    expect(result.results.recover.summary).toBe("RECOVER done");
    // The failed step never spawned an LLM turn, and @fast (entry 2) was never tried.
    expect(served.map((s) => s.marker)).toEqual(["PREP", "RECOVER"]);
    expect(emitted).not.toContain("@fast");
  });
});

describe("e2e faux: strict mode (flows.modelFallback = error)", () => {
  const STRICT_WITH_ON_ERROR = `name: strict-recover
description: strict mode with an on_error edge
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN \${{task}}"
  - id: build
    type: agent
    agent: builder
    task: "BUILD it"
    blockedBy: [plan]
    on_error: wrapup
  - id: publish
    type: agent
    agent: reviewer
    task: "PUBLISH it"
    blockedBy: [build]
  - id: wrapup
    type: agent
    agent: reviewer
    task: "WRAPUP after \${{result.plan.summary}}"
    blockedBy: [publish]
`;

  it("fails the step naming the ref; with on_error the flow continues to the recovery step", async () => {
    const { flow, agents } = author(STRICT_WITH_ON_ERROR, [
      agentMd("planner", "faux/faux-1"),
      agentMd("builder", "@coding"),
      agentMd("reviewer", "faux/faux-1"),
    ]);
    const { served, responder } = recorder();
    const result = await runFaux({ flow, agents, responder, modelFallback: "error" });

    expect(result.status).toBe("success");
    expect(result.results.build.status).not.toBe("complete");
    expect(result.results.build.summary).toContain("@coding");
    expect(result.results.build.summary).toMatch(/no model entry resolved/i);
    expect(result.results.publish.status).toBe("skipped");
    expect(result.results.wrapup.status).toBe("complete");
    expect(served.map((s) => s.marker)).toEqual(["PLAN", "WRAPUP"]);
  });

  it("without on_error the flow halts and later steps never spawn", async () => {
    const yaml = STRICT_WITH_ON_ERROR.replace("    on_error: wrapup\n", "");
    const { flow, agents } = author(yaml, [
      agentMd("planner", "faux/faux-1"),
      agentMd("builder", "@coding"),
      agentMd("reviewer", "faux/faux-1"),
    ]);
    const { served, responder } = recorder();
    const startedSteps: string[] = [];
    const result = await runFaux({
      flow, agents, responder, modelFallback: "error",
      onAgentStarted: (_n, step) => startedSteps.push(step),
    });

    expect(result.status).toBe("error");
    expect(result.lastResult.result.status).toBe("error");
    expect(result.lastResult.result.summary).toContain("@coding");
    expect(served.map((s) => s.marker)).toEqual(["PLAN"]);
    expect(startedSteps).not.toContain("publish");
    expect(startedSteps).not.toContain("wrapup");
    expect(result.results.publish).toBeUndefined();
    expect(result.results.wrapup).toBeUndefined();
  });

  it("strict mode leaves resolvable refs alone (literal + a resolving handler)", async () => {
    const { flow, agents } = author(THREE_STEP, [
      agentMd("planner", "faux/faux-1"),
      agentMd("builder", "@coding"),
      agentMd("reviewer", "[@missing, faux/faux-1]"),
    ]);
    const { served, responder } = recorder();
    const result = await runFaux({
      flow, agents, responder, modelFallback: "error",
      resolveHandler: (probe) => {
        if (probe.ref === "@coding") { probe.model = fauxModel("faux-coding"); probe.resolved = "faux/faux-coding"; }
        if (probe.ref === "@missing") probe.error = "not assigned";
      },
    });
    expect(result.status).toBe("success");
    expect(served.map((s) => s.modelId)).toEqual(["faux-1", "faux-coding", "faux-1"]);
  });
});

describe("e2e faux: no session model available", () => {
  const TWO_STEP = `name: no-session
description: first step is fine, second has no model
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN \${{task}}"
  - id: build
    type: agent
    agent: modelless
    task: "BUILD it"
    blockedBy: [plan]
  - id: review
    type: agent
    agent: planner
    task: "REVIEW it"
    blockedBy: [build]
`;

  it("an agent with no model: fails with an error naming the agent; the flow halts", async () => {
    const { flow, agents } = author(TWO_STEP, [agentMd("planner", "faux/faux-1"), agentMd("modelless", null)]);
    const { served, responder } = recorder();
    const result = await runFaux({ flow, agents, responder, withoutParentModel: true });

    expect(result.status).toBe("error");
    const msg = result.lastResult.result.summary;
    expect(msg).toContain("modelless");
    expect(msg).toMatch(/session model/i);
    // plan (literal, resolvable via the registry) ran; the modelless agent never reached the LLM.
    expect(served.map((s) => s.marker)).toEqual(["PLAN"]);
    expect(result.results.review).toBeUndefined();
  });

  it("all-unresolvable @-refs also name the agent and the refs", async () => {
    const { flow, agents } = author(TWO_STEP, [agentMd("planner", "faux/faux-1"), agentMd("modelless", "[@fast, @coding]")]);
    const { responder } = recorder();
    const result = await runFaux({ flow, agents, responder, withoutParentModel: true });
    expect(result.status).toBe("error");
    const msg = result.lastResult.result.summary;
    expect(msg).toContain("modelless");
    expect(msg).toContain("@fast");
    expect(msg).toContain("@coding");
  });

  it("with an on_error edge the recovery step (a literal model) still runs", async () => {
    const yaml = TWO_STEP.replace('task: "BUILD it"\n    blockedBy: [plan]', 'task: "BUILD it"\n    blockedBy: [plan]\n    on_error: review');
    const { flow, agents } = author(yaml, [agentMd("planner", "faux/faux-1"), agentMd("modelless", null)]);
    const { served, responder } = recorder();
    const result = await runFaux({ flow, agents, responder, withoutParentModel: true });
    expect(result.status).toBe("success");
    expect(result.results.build.summary).toContain("modelless");
    expect(served.map((s) => s.marker)).toEqual(["PLAN", "REVIEW"]);
  });
});

describe("e2e faux: thinking suffix", () => {
  const ONE = (agent: string) => `name: thinking
description: one step
steps:
  - id: build
    type: agent
    agent: ${agent}
    task: "BUILD it"
`;

  it("`@coding:high` is handed to the resolver verbatim (suffix parsing is the resolver's job) and the resolved model runs", async () => {
    const { flow, agents } = author(ONE("builder"), [agentMd("builder", "@coding:high")]);
    expect(agents[0].modelRefs).toEqual(["@coding:high"]);
    const probes: any[] = [];
    const { served, responder } = recorder();
    const started: Started[] = [];
    const result = await runFaux({
      flow, agents, responder,
      resolveHandler: (probe) => {
        probes.push({ ref: probe.ref });
        const [role, level] = String(probe.ref).split(":");
        if (role === "@coding") {
          probe.model = fauxModel("faux-coding");
          probe.resolved = "faux/faux-coding";
          probe.thinkingLevel = level;
        }
      },
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });
    expect(result.status).toBe("success");
    // Exactly one emit for the one ref, carrying the full suffix.
    expect(probes).toEqual([{ ref: "@coding:high" }]);
    expect(served).toEqual([{ marker: "BUILD", modelId: "faux-coding" }]);
    expect(started[0].model).toBe("faux/faux-coding");
    expect(started[0].extra?.modelFallback).toBeUndefined();
  });

  it("an unresolved `@coding:high` falls back to the session model and reports the requested ref with its suffix", async () => {
    const { flow, agents } = author(ONE("builder"), [agentMd("builder", "@coding:high")]);
    const { served, responder } = recorder();
    const started: Started[] = [];
    const result = await runFaux({
      flow, agents, responder,
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });
    expect(result.status).toBe("success");
    expect(served[0].modelId).toBe("faux-1");
    expect(started[0].extra.modelFallback).toEqual({ requested: ["@coding:high"], used: "faux/faux-1", reason: "no-resolver" });
  });

  it("a literal `faux/faux-1:high` resolves through the registry fallback with the suffix stripped before lookup", async () => {
    const { flow, agents } = author(ONE("builder"), [agentMd("builder", "faux/faux-1:high")]);
    const { served, responder } = recorder();
    const started: Started[] = [];
    const result = await runFaux({
      flow, agents, responder,
      onAgentStarted: (name, step, model, extra) => started.push({ name, step, model, extra }),
    });
    expect(result.status).toBe("success");
    expect(served[0].modelId).toBe("faux-1");
    expect(started[0].model).toBe("faux/faux-1");
    expect(started[0].extra?.modelFallback).toBeUndefined();
  });

  it("authoring: any @-ref and a valid suffix pass; an invalid suffix is an error naming the level; a literal's colon id is not a suffix", () => {
    const errorsOf = (m: string) => validateAgentContent(m).diagnostics.filter((d) => d.severity === "error");
    const anyOf = (m: string) => validateAgentContent(m).diagnostics.filter((d) => /model/i.test(d.message));
    expect(anyOf(agentMd("a", "@my-custom-alias"))).toEqual([]);
    expect(errorsOf(agentMd("a", "@coding:high"))).toEqual([]);
    expect(errorsOf(agentMd("a", "[@fast, faux/faux-1]"))).toEqual([]);
    expect(errorsOf(agentMd("a", null))).toEqual([]);
    expect(anyOf(agentMd("a", "ollama/llama3:8b"))).toEqual([]);

    const bad = errorsOf(agentMd("a", "@fast:extreme"));
    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain("extreme");
    expect(JSON.stringify(bad[0])).toMatch(/minimal.*low.*medium.*high/s);
  });
});

describe("e2e faux: flow:agent-started carries the whole model: list (production event path)", () => {
  const FLOW = `name: refs
description: agents with list, single and no model refs plus a decision agent
decision_agent: judge
steps:
  - id: plan
    type: agent
    agent: planner
    task: "PLAN \${{task}}"
  - id: build
    type: agent
    agent: builder
    task: "BUILD"
    blockedBy: [plan]
  - id: gate
    type: agent-decision
    task: "GATE ok?"
    blockedBy: [build]
    branches:
      done: review
      redo: review
  - id: review
    type: agent
    agent: reviewer
    task: "REVIEW"
`;

  it("modelRefs lists every entry in order (list, single @role, literal); absent when no model: is declared", async () => {
    const parent = await makeParentSession("rtprov", [{ id: "m1" }]);
    parent.faux.setResponses(Array.from({ length: 12 }, () => (context: any) => {
      const last = JSON.stringify(context?.messages?.at(-1) ?? "");
      return /GATE/.test(last)
        ? scriptFinish({ status: "complete", summary: "judged", branch: "done" })
        : scriptFinish({ status: "complete", summary: "ok" });
    }));
    const host = await bootExtension({ "e2e/refs": FLOW }, {
      planner: agentMd("planner", "[@missing, rtprov/m1]"),
      builder: agentMd("builder", "@fast"),
      judge: agentMd("judge", "rtprov/m1"),
      reviewer: agentMd("reviewer", null),
    });
    const started: any[] = [];
    host.pi.events.on("flow:agent-started", (e: any) => started.push(e));
    await host.fire("session_start", { ...parent.ctx, model: parent.registry.find("rtprov", "m1") });
    const done = await runFlowViaEvent(host, "e2e:refs");
    expect(JSON.stringify(done)).toMatch(/success/);

    const cfg = (step: string, name: string) => started.find((e) => e.stepId === step && e.agentName === name)?.config;
    expect(cfg("plan", "planner")).toMatchObject({ name: "planner", model: "@missing", modelRefs: ["@missing", "rtprov/m1"] });
    expect(cfg("build", "builder")).toMatchObject({ model: "@fast", modelRefs: ["@fast"] });
    expect(cfg("gate", "judge")).toMatchObject({ name: "judge", modelRefs: ["rtprov/m1"] });
    const reviewer = cfg("review", "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer.modelRefs).toBeUndefined();
    // The card still reports the fallback for the unresolvable role.
    const builder = started.find((e) => e.stepId === "build" && e.config);
    expect(builder.modelFallback).toMatchObject({ requested: ["@fast"], used: "rtprov/m1" });
  });
});
