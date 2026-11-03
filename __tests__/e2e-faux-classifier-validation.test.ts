/**
 * End-to-end faux tests for classifier-decisions: authoring-time validation,
 * the "pi too old" fallback and the System One privacy switch.
 *
 * Flows are authored as YAML + markdown agents, validated, parsed and (where a
 * run is needed) executed on the real `runFlow` with the faux provider.
 * Assertions encode openspec/changes/classifier-decisions and docs/flows.md.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFauxRegistry, registerFauxOnRuntime, runFaux, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { runFlow } from "../extensions/flow-engine/flow-execution.js";
import type { DecisionEvent } from "../extensions/flow-engine/types.js";

// ---- authoring helpers -----------------------------------------------------

const agentMd = (name: string) => `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n`;
const MDS = [agentMd("worker"), agentMd("judge")];
const AGENTS = MDS.map((m) => parseAgentString(m, "<e2e>"));
const BY_NAME = new Map(AGENTS.map((a) => [a.name, a]));

const flowYaml = (opts: { top?: string; gate?: string; means?: boolean } = {}) => `name: gate-flow
description: validation target
decision_agent: judge
${opts.top ?? ""}steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
  - id: gate
    type: agent-decision
    task: "GATE: is it fine?"
    blockedBy: [build]
${opts.gate ?? ""}    branches:
      ok: ${opts.means === false ? "ship" : '{ to: ship, means: "it is fine" }'}
      bad: ${opts.means === false ? "fix" : '{ to: fix, means: "it is broken" }'}
  - id: ship
    type: agent
    agent: worker
    task: "SHIP"
  - id: fix
    type: agent
    agent: worker
    task: "FIX"
`;

const validate = (yaml: string, isKnownClassifier?: (ref: string) => boolean) =>
  validateFlowContent(yaml, () => BY_NAME, isKnownClassifier);
const errors = (yaml: string, known?: (ref: string) => boolean) => validate(yaml, known).diagnostics.filter((d) => d.severity === "error");
const warnings = (yaml: string) => validate(yaml).diagnostics.filter((d) => d.severity === "warning");

const ran = (r: any, id: string) => r.results[id]?.status === "complete";
const judge = (branch: string) => (t: string) =>
  t.includes("GATE:") ? scriptFinish({ status: "complete", summary: "judged", branch }) : scriptFinish({ status: "complete", summary: "worked" });

// ---- validation ------------------------------------------------------------

describe("e2e faux: decider validation (authoring)", () => {
  it("a baseline flow with a valid classifier chain has no errors and no warnings", () => {
    const yaml = flowYaml({ top: "decider: { chain: [system-one, typesafe/jev-latest, agent], trust: auto, min_confidence: 0.75 }\n" });
    expect(validate(yaml).diagnostics).toEqual([]);
  });

  it("an unknown decider entry is an error naming it and the allowed forms (flow and step level)", () => {
    for (const yaml of [flowYaml({ top: "decider: [magic, agent]\n" }), flowYaml({ gate: "    decider: [system-one, magic]\n" })]) {
      const errs = errors(yaml);
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toContain("magic");
      expect(`${errs[0].message} ${errs[0].suggestion}`).toMatch(/system-one/);
      expect(`${errs[0].message} ${errs[0].suggestion}`).toMatch(/agent/);
      expect(`${errs[0].message} ${errs[0].suggestion}`).toMatch(/provider\/model/);
    }
    // the step-level error is reported against the step's own line, not the file top
    const stepErr = errors(flowYaml({ gate: "    decider: [system-one, magic]\n" }))[0];
    expect(stepErr.message).toContain('"gate"');
    expect(stepErr.line).toBeGreaterThan(1);
  });

  it("`trust` must be auto | calibrated | confidence", () => {
    for (const trust of ["auto", "calibrated", "confidence"]) {
      expect(errors(flowYaml({ top: `decider: { chain: [system-one, agent], trust: ${trust} }\n` })), trust).toEqual([]);
    }
    const bad = errors(flowYaml({ top: "decider: { chain: [system-one, agent], trust: paranoid }\n" }));
    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain("paranoid");
    expect(bad[0].suggestion).toMatch(/auto.*calibrated.*confidence/);
    // also at step level
    expect(errors(flowYaml({ gate: "    decider: { trust: sometimes }\n" }))[0].message).toContain("sometimes");
  });

  it("`min_confidence` outside [0, 1] (or not a number) is an error; the bounds are accepted", () => {
    for (const ok of ["0", "0.75", "1"]) {
      expect(errors(flowYaml({ top: `decider: { chain: [system-one, agent], min_confidence: ${ok} }\n` })), ok).toEqual([]);
    }
    for (const bad of ["1.5", "-0.1", "high"]) {
      const errs = errors(flowYaml({ top: `decider: { chain: [system-one, agent], min_confidence: ${bad} }\n` }));
      expect(errs, bad).toHaveLength(1);
      expect(errs[0].message).toMatch(/min_confidence.*between 0 and 1/);
    }
  });

  it("warns, naming each branch, when a classifier chain has branches without `means`", () => {
    const w = warnings(flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n", means: false }));
    expect(w).toHaveLength(2);
    expect(w.map((d) => d.message).join("\n")).toMatch(/"ok"[\s\S]*"bad"|"bad"[\s\S]*"ok"/);
    expect(w.every((d) => d.message.includes("means"))).toBe(true);
    // a step-level chain triggers it too
    expect(warnings(flowYaml({ gate: "    decider: [system-one, agent]\n", means: false }))).toHaveLength(2);
    // ... but never an error: the flow stays valid
    expect(errors(flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n", means: false }))).toEqual([]);
  });

  it("does not warn for an agent-only chain, nor when every branch has `means`", () => {
    expect(warnings(flowYaml({ means: false }))).toEqual([]); // default chain = [agent]
    expect(warnings(flowYaml({ top: "decider: [agent]\n", means: false }))).toEqual([]);
    expect(warnings(flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n", means: true }))).toEqual([]);
  });

  it("rejects a `provider/model` ref the classifier predicate does not know; `system-one` and `agent` are exempt", () => {
    const asked: string[] = [];
    const known = (ref: string) => { asked.push(ref); return ref === "typesafe/jev-latest"; };
    expect(errors(flowYaml({ top: "decider: [system-one, typesafe/jev-latest, agent]\n" }), known)).toEqual([]);
    expect(asked).toEqual(["typesafe/jev-latest"]);

    const errs = errors(flowYaml({ top: "decider: [anthropic/claude-haiku-4-5, agent]\n" }), known);
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("anthropic/claude-haiku-4-5");
    expect(errs[0].message).toMatch(/not a classifier model/);
    // a step-level unknown classifier is rejected as well
    expect(errors(flowYaml({ gate: "    decider: [openai/gpt-chat]\n" }), known)[0].message).toMatch(/gpt-chat.*not a classifier model/);
    // without a catalog (predicate absent) nothing is rejected
    expect(errors(flowYaml({ top: "decider: [anthropic/claude-haiku-4-5, agent]\n" }))).toEqual([]);
  });
});

// ---- pi too old ------------------------------------------------------------

describe("e2e faux: pi too old for classifier models", () => {
  it("a provider/model entry on a registry without classify/getModelOfType fails with the version reason; the agent decides", async () => {
    const yaml = flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n" });
    expect(errors(yaml)).toEqual([]);
    const events: DecisionEvent[] = [];
    // runFaux's registry stub has neither `classify` nor `getModelOfType`, i.e. a pi < 0.99.0 registry; no override.
    const r = await runFaux({
      flow: parseFlowYamlString(yaml, "<e2e>"), agents: AGENTS, responder: judge("bad"),
      onDecision: (e) => events.push(e),
    });
    expect(r.status).not.toBe("error");
    expect(ran(r, "fix")).toBe(true);
    expect(events[0]).toMatchObject({ routedBy: "agent", label: "bad" });
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["typesafe/jev-latest", "error"], ["agent", "ok"]]);
    expect(events[0].attempts[0].reason).toMatch(/^pi too old/);
    expect(events[0].attempts[0].reason).toContain("0.99.0");
  });

  it("with no agent in the chain the failure is visible in the step error", async () => {
    const yaml = flowYaml({ top: "decider: [typesafe/jev-latest]\n" });
    const r = await runFaux({ flow: parseFlowYamlString(yaml, "<e2e>"), agents: AGENTS, responder: judge("ok") });
    expect(r.status).toBe("error");
    expect(r.lastResult.result.summary).toMatch(/pi too old/);
    expect(ran(r, "ship")).toBe(false);
  });
});

// ---- real adapters under a temp HOME ----------------------------------------

/** `runFaux` with a caller-supplied pi `modelRegistry` extension (classify / getModelOfType). */
async function runWithRegistry(yaml: string, extra: Record<string, unknown>, cwd: string, responder: (t: string) => any) {
  const { faux, runtime } = await registerFauxOnRuntime({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });
  const factory = (context: any): any => {
    const msgs = context?.messages ?? [];
    const last = [...msgs].reverse().find((m: any) => m.role === "user");
    const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b: any) => b.text ?? "").join("\n");
    return responder(text);
  };
  faux.setResponses(Array.from({ length: 24 }, () => factory));
  const registry = { ...makeFauxRegistry(faux), ...extra };
  const agentMap = new Map(AGENTS.map((a) => [a.name, a]));
  const pi: any = { events: { emit: () => undefined, on: () => undefined }, modelRegistry: registry };
  const events: DecisionEvent[] = [];
  try {
    const r = await runFlow({
      flow: parseFlowYamlString(yaml, "<e2e>"), task: "flow task", cwd,
      modelRegistry: registry, modelRuntime: runtime, pi,
      getAgent: (n: string) => agentMap.get(n),
      askUser: async () => ({ answer: "" }),
      onDecision: (e: DecisionEvent) => events.push(e),
      parentModel: { model: faux.getModel("faux-1") as any },
    } as any);
    return { r, events };
  } finally {
    faux.unregister();
  }
}

describe("e2e faux: pi-ai classifier adapter + System One privacy switch (temp HOME)", () => {
  const oldHome = process.env.HOME;
  let home: string, cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "e2e-s1-home-"));
    cwd = mkdtempSync(join(tmpdir(), "e2e-s1-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  });

  const writeUserConfig = (cfg: object) => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "system-one.json"), JSON.stringify({ version: 1, backends: {}, presets: {}, activePreset: "", ...cfg }));
  };
  /** A pi >= 0.99 registry slice: one hosted and one loopback classifier model. */
  const registryParts = (opts: { auth?: boolean } = {}) => {
    const models: Record<string, any> = {
      "typesafe/jev-latest": { id: "jev-latest", provider: "typesafe", baseUrl: "https://api.typesafe.example/v1" },
      "local/llama": { id: "llama", provider: "local", baseUrl: "http://127.0.0.1:8080/v1" },
    };
    const classify = vi.fn(async (model: any, _req?: any, _opts?: any) => ({
      stopReason: "stop", model: model.id,
      answers: { decision: { type: "choice", choice: "ok", probabilities: { ok: 0.95, bad: 0.05 }, confidence: 0.95 } },
    }));
    return {
      classify,
      parts: {
        getModelOfType: (_kind: string, provider: string, id: string) => models[`${provider}/${id}`],
        hasConfiguredAuth: () => opts.auth !== false,
        classify,
      },
    };
  };

  it("allowOffMachine:false skips a hosted pi-ai entry with `off-machine` (no request) and the agent decides", async () => {
    writeUserConfig({ allowOffMachine: false });
    const { classify, parts } = registryParts();
    const yaml = flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n" });
    const { r, events } = await runWithRegistry(yaml, parts, cwd, judge("bad"));
    expect(classify).not.toHaveBeenCalled();
    expect(r.status).not.toBe("error");
    expect(ran(r, "fix")).toBe(true);
    expect(ran(r, "ship")).toBe(false);
    expect(events[0]).toMatchObject({ routedBy: "agent", label: "bad" });
    expect(events[0].attempts[0]).toMatchObject({ entry: "typesafe/jev-latest", outcome: "off-machine" });
    expect(events[0].attempts[0].reason).toMatch(/off this machine|allowOffMachine/);
  });

  it("a loopback classifier later in the chain is still used under allowOffMachine:false", async () => {
    writeUserConfig({ allowOffMachine: false });
    const { classify, parts } = registryParts();
    const yaml = flowYaml({ top: "decider: [typesafe/jev-latest, local/llama, agent]\n" });
    const { r, events } = await runWithRegistry(yaml, parts, cwd, judge("bad"));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0]).toMatchObject({ provider: "local" });
    expect(events[0].attempts.map((a) => [a.entry, a.outcome])).toEqual([["typesafe/jev-latest", "off-machine"], ["local/llama", "ok"]]);
    expect(events[0]).toMatchObject({ routedBy: "local/llama", label: "ok" });
    expect(ran(r, "ship")).toBe(true);
  });

  it("without any System One configuration there is no extra gate: the hosted classifier routes", async () => {
    const { classify, parts } = registryParts();
    const yaml = flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n" });
    const { r, events } = await runWithRegistry(yaml, parts, cwd, judge("bad"));
    expect(classify).toHaveBeenCalledTimes(1);
    // the single `choice` question named `decision` with the branch criteria
    expect(classify.mock.calls[0][1]).toMatchObject({
      state: { task: "GATE: is it fine?" },
      questions: { decision: { type: "choice", criteria: { ok: "it is fine", bad: "it is broken" } } },
    });
    expect(events[0]).toMatchObject({ routedBy: "typesafe/jev-latest", label: "ok" });
    expect(events[0].attempts[0]).toMatchObject({ outcome: "ok", trusted: true, model: "typesafe/jev-latest" });
    expect(ran(r, "ship")).toBe(true);
  });

  it("a missing credential falls through with a reason naming the provider, without a request", async () => {
    const { classify, parts } = registryParts({ auth: false });
    const yaml = flowYaml({ top: "decider: [typesafe/jev-latest, agent]\n" });
    const { r, events } = await runWithRegistry(yaml, parts, cwd, judge("bad"));
    expect(classify).not.toHaveBeenCalled();
    expect(events[0].attempts[0]).toMatchObject({ entry: "typesafe/jev-latest", outcome: "credentials" });
    expect(events[0].attempts[0].reason).toContain("typesafe");
    expect(events[0].routedBy).toBe("agent");
    expect(ran(r, "fix")).toBe(true);
  });

  it("an unknown classifier model fails the attempt at run time (and the agent decides)", async () => {
    const { parts } = registryParts();
    const yaml = flowYaml({ top: "decider: [nobody/nothing, agent]\n" });
    const { r, events } = await runWithRegistry(yaml, parts, cwd, judge("ok"));
    expect(events[0].attempts[0]).toMatchObject({ entry: "nobody/nothing", outcome: "error" });
    expect(events[0].attempts[0].reason).toMatch(/not a known classifier model/);
    expect(ran(r, "ship")).toBe(true);
  });

  it("`system-one` with no configuration fails with no-backend (no network) and the chain continues", async () => {
    const yaml = flowYaml({ top: "decider: [system-one, agent]\n" });
    const { r, events } = await runWithRegistry(yaml, {}, cwd, judge("ok"));
    expect(events[0]).toMatchObject({ consumerId: "pi-flows:gate-flow:gate", routedBy: "agent", label: "ok" });
    expect(events[0].attempts[0]).toMatchObject({ entry: "system-one", outcome: "no-backend" });
    expect(events[0].attempts[0].reason).toContain("no-backend");
    expect(ran(r, "ship")).toBe(true);
  });
});
