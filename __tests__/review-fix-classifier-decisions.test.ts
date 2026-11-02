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

// ---------------------------------------------------------------------------
// C2 — 15 s timeout applies to pi-ai entries, not to system-one
// ---------------------------------------------------------------------------
import { decide } from "../extensions/flow-engine/decider/chain.js";
import type { EntryResult } from "../extensions/flow-engine/decider/types.js";

describe("C2 — decider timeouts (design D9)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const base = { trust: "confidence" as const, minConfidence: 0.5, labels: ["done", "fix"] };
  const slowOk = (ms: number): Promise<EntryResult> =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true, answer: { label: "done", confidence: 0.9 } }), ms));

  it("a system-one entry slower than 15 s is not cut off", async () => {
    const p = decide({ ...base, entries: ["system-one"], run: () => slowOk(40_000) });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toMatchObject({ ok: true, label: "done", routedBy: "system-one" });
  });

  it("a pi-ai entry slower than 15 s times out", async () => {
    const p = decide({ ...base, entries: ["a/b"], run: () => slowOk(40_000) });
    await vi.advanceTimersByTimeAsync(16_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.attempts[0]).toMatchObject({ entry: "a/b", outcome: "timeout" });
  });
});

// ---------------------------------------------------------------------------
// C3 — pi too old for classifier models
// ---------------------------------------------------------------------------
import { createPiAiEntry } from "../extensions/flow-engine/decider/pi-ai.js";
import { registerFlowWriteTool } from "../extensions/flow-engine/tools/flow-write.js";

const TOO_OLD = "pi too old: classifier models need pi >= 0.99.0";

describe("C3 — pi too old", () => {
  it("pi-ai entry fails with the version reason when the registry has no classifier API", async () => {
    for (const registry of [{}, { getModelOfType: () => ({}) }, undefined]) {
      const r = await createPiAiEntry({ ref: "typesafe/jev-latest", registry, blockOffMachine: false, isLoopbackHost: () => true })(q, sig);
      expect(r).toMatchObject({ ok: false, outcome: "error", reason: TOO_OLD });
    }
  });

  it("flow_write warns (does not silently skip) when the registry lacks getModelOfType", async () => {
    const root = mkdtempSync(join(tmpdir(), "c3-"));
    const tools = new Map<string, any>();
    const pi: any = { registerTool: (t: any) => tools.set(t.name, t), events: { emit: () => {} } };
    registerFlowWriteTool(pi, () => new Map([["a", { name: "a" } as any]]), root);
    const flow =
      "name: x\ndescription: d\ndecider: [typesafe/jev-latest, agent]\nsteps:\n  - id: s\n    type: agent\n    agent: a\n";
    const out = JSON.parse((await tools.get("flow_write").execute("1", { name: "f", content: flow }, undefined, undefined, { modelRegistry: {} })).content[0].text);
    expect(out.written).toBe(true);
    expect(out.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "warning", message: expect.stringContaining(TOO_OLD) })]));

    const plain = "name: y\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: a\n";
    const out2 = JSON.parse((await tools.get("flow_write").execute("1", { name: "g", content: plain }, undefined, undefined, { modelRegistry: {} })).content[0].text);
    expect(JSON.stringify(out2.diagnostics)).not.toContain("pi too old");
  });
});

// ---------------------------------------------------------------------------
// Missing coverage: trust `auto`, and a System One `llm` backend end-to-end
// ---------------------------------------------------------------------------
describe("decide() with trust auto", () => {
  const base = { trust: "auto" as const, minConfidence: 0.75, labels: ["done", "fix"] };

  it("calibration record in shadow mode + confidence 0.99 → does not route; next entry decides", async () => {
    const calls: string[] = [];
    const r = await decide({
      ...base,
      entries: ["system-one", "agent"],
      run: async (e): Promise<EntryResult> => {
        calls.push(e);
        return e === "agent"
          ? { ok: true, authoritative: true, answer: { label: "fix", confidence: 1 } }
          : { ok: true, calibrated: true, answer: { label: "done", confidence: 0.99, mode: "shadow" } };
      },
    });
    expect(calls).toEqual(["system-one", "agent"]);
    expect(r).toMatchObject({ ok: true, label: "fix", routedBy: "agent" });
    expect(r.attempts[0]).toMatchObject({ entry: "system-one", outcome: "untrusted", trusted: false, agreed: false });
  });

  it("no calibration + confidence 0.9 → routes", async () => {
    const calls: string[] = [];
    const r = await decide({
      ...base,
      entries: ["system-one", "agent"],
      run: async (e): Promise<EntryResult> => {
        calls.push(e);
        return { ok: true, calibrated: false, answer: { label: "done", confidence: 0.9, mode: "shadow" } };
      },
    });
    expect(calls).toEqual(["system-one"]);
    expect(r).toMatchObject({ ok: true, label: "done", routedBy: "system-one" });
  });
});

describe("System One llm backend through the real predict()", () => {
  const oldHome = process.env.HOME;
  afterEach(() => { process.env.HOME = oldHome; });

  it("is answered by pi-flows' llm caller (mocked completion) and routes without an agent session", async () => {
    const home = mkdtempSync(join(tmpdir(), "s1-llm-home-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "system-one.json"), JSON.stringify({
      version: 1,
      allowOffMachine: true,
      backends: { llm1: { kind: "llm", role: "@fast" } },
      presets: { p: { chain: ["llm1"] } },
      activePreset: "p",
    }));
    const cwd = mkdtempSync(join(tmpdir(), "s1-llm-cwd-"));
    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: '{"decision":{"choice":"done","probabilities":{"done":0.92,"fix":0.08}}}' }],
    }));
    const agentEntry = vi.fn(async () => { throw new Error("agent session must not be spawned"); });
    const parentModel = { model: { id: "m1", provider: "prov" } as any };
    const run = makeEntryRunner({
      env: { pi: { events: { emit: () => {} } }, cwd, modelRegistry: {}, modelRuntime: { complete }, parentModel, projectTrusted: true } as any,
      flowName: "f", stepId: "s", branchCount: 2, question: q, agentEntry,
    });
    const outcome = await decide({
      trust: "auto", minConfidence: 0.75, labels: ["done", "fix"],
      entries: ["system-one", "agent"],
      run,
    });
    expect(outcome).toMatchObject({ ok: true, label: "done", routedBy: "system-one" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(agentEntry).not.toHaveBeenCalled();
  });
});
