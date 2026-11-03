/**
 * Spec: flow-model-resolution — session-model fallback, fallback reporting,
 * resolved-Model hand-off. Drives the real runFlow/spawnAgent via faux.
 */
import { describe, expect, it } from "vitest";
import { runFaux, makeAgent, scriptFinish, registerFauxOnRuntime, makeFauxRegistry } from "./faux-harness.js";
import { runFlow } from "../extensions/flow-engine/flow-execution.js";
import { spawnAgent } from "../extensions/flow-engine/execution.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

const oneStep: FlowConfig = {
  name: "f", description: "d", source: "<t>",
  steps: [{ stepType: "agent", id: "a", agent: "w", task: "go" }],
};
const done = () => scriptFinish({ status: "complete", summary: "ok" });

describe("session-model fallback in a flow", () => {
  it("@fast with no resolver runs on the parent model and reports the fallback", async () => {
    const started: any[] = [];
    const r = await runFaux({
      flow: oneStep,
      agents: [makeAgent({ name: "w", model: "@fast", modelRefs: ["@fast"] })],
      responder: done,
      onAgentStarted: (...a) => started.push(a),
    });
    expect(r.results.a.status).toBe("complete");
    const extra = started.find((a) => a[1] === "a")[3];
    expect(extra.modelFallback).toEqual({ requested: ["@fast"], used: "faux/faux-1", reason: "no-resolver" });
  });

  it("strict mode fails the step naming @fast", async () => {
    const r = await runFaux({
      flow: oneStep,
      agents: [makeAgent({ name: "w", model: "@fast", modelRefs: ["@fast"] })],
      responder: done,
      modelFallback: "error",
    });
    expect(r.results.a.status).not.toBe("complete");
    expect(JSON.stringify(r)).toContain("@fast");
  });

  it("agent without model runs on the parent model", async () => {
    const r = await runFaux({
      flow: oneStep,
      agents: [makeAgent({ name: "w", model: undefined, modelRefs: [] })],
      responder: done,
    });
    expect(r.results.a.status).toBe("complete");
  });
});

describe("resolved Model is used directly", () => {
  it("handler Model absent from the registry → step succeeds", async () => {
    const { faux, runtime } = await registerFauxOnRuntime({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });
    faux.setResponses(Array.from({ length: 6 }, () => done()));
    const real = makeFauxRegistry(faux);
    const model = faux.getModel("faux-1");
    const emptyRegistry = { ...real, find: () => undefined, getAll: () => [] };
    const pi: any = {
      events: { emit: (_c: string, p: any) => { p.model = model; p.resolved = "other/not-in-registry"; }, on: () => undefined },
    };
    try {
      const r = await runFlow({
        flow: oneStep, task: "t", cwd: process.cwd(),
        modelRegistry: emptyRegistry, modelRuntime: runtime, pi,
        getAgent: () => makeAgent({ name: "w", model: "@fast", modelRefs: ["@fast"] }),
        askUser: async () => ({ answer: "" }),
      });
      expect(r.results.a.status).toBe("complete");
    } finally {
      faux.unregister();
    }
  });

  it("spawnAgent with resolvedModel never calls registry.find", async () => {
    const { faux, runtime } = await registerFauxOnRuntime({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });
    faux.setResponses([done()]);
    let finds = 0;
    const reg = { ...makeFauxRegistry(faux), find: () => { finds++; return undefined; }, getAll: () => { finds++; return []; } };
    try {
      const res = await spawnAgent({
        agent: makeAgent(), task: "x", templateContext: { task: "x", inputs: {}, results: {} },
        pi: {} as any, cwd: process.cwd(), modelRegistry: reg as any, modelRuntime: runtime,
        resolvedModel: faux.getModel("faux-1") as any, resolvedModelId: "faux/faux-1",
      });
      expect(res.success).toBe(true);
      expect(finds).toBe(0);
    } finally {
      faux.unregister();
    }
  });
});
