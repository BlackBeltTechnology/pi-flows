/**
 * Review-fix tests for change `classifier-decisions`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEntryRunner } from "../extensions/flow-engine/decider/runtime.js";
import type { DecisionQuestion } from "../extensions/flow-engine/decider/types.js";

const q: DecisionQuestion = {
  state: { task: "review it" },
  question: { type: "choice", instructions: "review it", criteria: { done: "ok", fix: "bad" } },
};
const sig = new AbortController().signal;

describe("C1 — privacy gate is evaluated per decision and includes project config", () => {
  const oldHome = process.env.HOME;
  let home: string, cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "c1-home-"));
    cwd = mkdtempSync(join(tmpdir(), "c1-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => { process.env.HOME = oldHome; });

  const writeUser = (cfg: object) => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "system-one.json"), JSON.stringify({ version: 1, ...cfg }));
  };
  const writeProject = (cfg: object) => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "system-one.json"), JSON.stringify({ version: 1, ...cfg }));
  };
  const hostedRegistry = () => ({
    getModelOfType: vi.fn(() => ({ id: "jev-latest", provider: "typesafe", baseUrl: "https://api.typesafe.example" })),
    hasConfiguredAuth: vi.fn(() => true),
    classify: vi.fn(async () => ({
      stopReason: "stop", model: "jev-latest",
      answers: { decision: { type: "choice", choice: "done", probabilities: { done: 0.9, fix: 0.1 }, confidence: 0.9 } },
    })),
  });
  const run = (registry: any, extra: object = {}) =>
    makeEntryRunner({
      env: { pi: {}, cwd, modelRegistry: registry, projectTrusted: true, ...extra } as any,
      flowName: "f", stepId: "s", branchCount: 2, question: q,
      agentEntry: async () => { throw new Error("no agent"); },
    })("typesafe/jev-latest", sig);

  it("changing system-one.json between runs is honoured (same pi object)", async () => {
    const pi = {};
    const reg1 = hostedRegistry();
    writeUser({ allowOffMachine: true, backends: {}, presets: {}, activePreset: "" });
    const mk = (reg: any) => makeEntryRunner({
      env: { pi, cwd, modelRegistry: reg, projectTrusted: true } as any,
      flowName: "f", stepId: "s", branchCount: 2, question: q,
      agentEntry: async () => { throw new Error("no agent"); },
    })("typesafe/jev-latest", sig);
    expect((await mk(reg1)).ok).toBe(true);

    writeUser({ allowOffMachine: false, backends: {}, presets: {}, activePreset: "" });
    const reg2 = hostedRegistry();
    const r2 = await mk(reg2);
    expect(r2).toMatchObject({ ok: false, outcome: "off-machine" });
    expect(reg2.classify).not.toHaveBeenCalled();
  });

  it("a trusted project .pi/system-one.json with allowOffMachine:false blocks a hosted entry", async () => {
    writeUser({ allowOffMachine: true, backends: {}, presets: {}, activePreset: "" });
    writeProject({ allowOffMachine: false });
    const reg = hostedRegistry();
    const r = await run(reg);
    expect(r).toMatchObject({ ok: false, outcome: "off-machine" });
    expect(reg.classify).not.toHaveBeenCalled();
  });

  it("an untrusted project config is ignored", async () => {
    writeUser({ allowOffMachine: true, backends: {}, presets: {}, activePreset: "" });
    writeProject({ allowOffMachine: false });
    const r = await run(hostedRegistry(), { projectTrusted: false });
    expect(r.ok).toBe(true);
  });
});
