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
// C2 — 15 s timeout applies to pi-ai (and llm calls), not to system-one
// ---------------------------------------------------------------------------
import { decide } from "../extensions/flow-engine/decider/chain.js";
import { createLlmCaller } from "../extensions/flow-engine/decider/llm-caller.js";
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

  it("the System One llm caller applies its own 15 s timeout to the completion", async () => {
    const caller = createLlmCaller({
      pi: {}, registry: {}, parentModel: { model: { id: "m", provider: "p" } } as any,
      complete: () => new Promise(() => {}), // never answers
    });
    const p = caller.call({ role: "@fast", state: "s", questions: {}, signal: new AbortController().signal } as any);
    const settled = p.then(() => "resolved", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await settled).toMatch(/15000 ms/);
  });
});
