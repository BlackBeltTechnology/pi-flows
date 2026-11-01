/** Spec: classifier-decisions — entry adapters (4.1, 4.3, 4.5). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemOneEntry, systemOneConsumerId } from "../extensions/flow-engine/decider/system-one.js";
import { createPiAiEntry } from "../extensions/flow-engine/decider/pi-ai.js";
import { createLlmCaller } from "../extensions/flow-engine/decider/llm-caller.js";
import type { DecisionQuestion } from "../extensions/flow-engine/decider/types.js";

const q: DecisionQuestion = {
  state: { task: "review it" },
  question: { type: "choice", instructions: "review it", criteria: { done: "ok", fix: "bad" } },
};
const sig = new AbortController().signal;

describe("systemOneConsumerId", () => {
  it("lowercases, sanitises, truncates to 128", () => {
    expect(systemOneConsumerId("Ship", "Review Gate")).toBe("pi-flows:ship:review-gate");
    expect(systemOneConsumerId("a".repeat(200), "b")).toHaveLength(128);
  });
});

describe("system-one entry (fake predict)", () => {
  const mk = (predict: any, loadConfig: any = () => ({ calibration: {} })) =>
    createSystemOneEntry({
      flowName: "ship", stepId: "review-gate", branchCount: 2, cwd: "/p", projectTrusted: true,
      llmCaller: { call: async () => ({ answers: {}, model: "m" }), isLocal: () => false },
      loadLib: async () => ({ predict, loadConfig }) as any,
    });

  it("sends the request shape and maps the answer", async () => {
    const predict = vi.fn(async (_req: unknown) => ({
      ok: true, backendId: "jev", model: "jev-1", mode: "shadow", thresholds: {}, latencyMs: 3, attempts: [],
      answers: { decision: { choice: "done", probabilities: { done: 0.9, fix: 0.1 }, confidence: 0.9 } },
    }));
    const r = await mk(predict)(q, sig);
    expect(r).toMatchObject({ ok: true, answer: { label: "done", confidence: 0.9, mode: "shadow", backendId: "jev", model: "jev-1" }, calibrated: false });
    const req = predict.mock.calls[0][0] as any;
    expect(req.consumer).toMatchObject({ id: "pi-flows:ship:review-gate", failurePolicy: "fail-open", requires: { primitives: ["choice"], maxOptions: 2 } });
    expect(req.consumer.label).toContain("ship");
    expect(req.state).toBe(JSON.stringify({ task: "review it" }));
    expect(req.questions.decision).toEqual(q.question);
    expect(req.project).toEqual({ cwd: "/p", trusted: true });
    expect(req.signal).toBe(sig);
    expect(typeof req.llmCaller.call).toBe("function");
  });
  it("reports calibrated when a record exists for backend::consumer", async () => {
    const predict = async () => ({ ok: true, backendId: "jev", model: "m", mode: "enforce", answers: { decision: { choice: "fix", probabilities: {}, confidence: 0.2 } } });
    const r = await mk(predict, () => ({ calibration: { "jev::pi-flows:ship:review-gate": { mode: "enforce" } } }))(q, sig);
    expect(r).toMatchObject({ ok: true, calibrated: true });
  });
  it("ok:false is a failed attempt with its reason", async () => {
    const r = await mk(async () => ({ ok: false, reason: "no-backend", policy: "fail-open", attempts: [{ backendId: "x", outcome: "timeout", latencyMs: 1 }] }))(q, sig);
    expect(r).toMatchObject({ ok: false, outcome: "no-backend" });
    expect((r as any).reason).toMatch(/no-backend/);
  });
  it("maps timeout/off-machine; capability/error → error", async () => {
    const f = (reason: string) => mk(async () => ({ ok: false, reason, policy: "fail-open", attempts: [] }))(q, sig);
    expect(await f("timeout")).toMatchObject({ outcome: "timeout" });
    expect(await f("off-machine")).toMatchObject({ outcome: "off-machine" });
    expect(await f("capability")).toMatchObject({ outcome: "error" });
  });
  it("library load failure → error attempt", async () => {
    const e = createSystemOneEntry({ flowName: "f", stepId: "s", branchCount: 2, cwd: "/", projectTrusted: false, llmCaller: undefined, loadLib: async () => { throw new Error("nope"); } });
    expect(await e(q, sig)).toMatchObject({ ok: false, outcome: "error" });
  });
});

describe("system-one entry (real library, no config)", () => {
  const oldHome = process.env.HOME;
  afterEach(() => { process.env.HOME = oldHome; });
  it("no config → no-backend, without network", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "s1-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "s1-cwd-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await createSystemOneEntry({ flowName: "ship", stepId: "gate", branchCount: 2, cwd, projectTrusted: true })(q, sig);
    expect(r).toMatchObject({ ok: false, outcome: "no-backend" });
    // Same consumer twice (dashboard + pi may both register it): still fine.
    expect(await createSystemOneEntry({ flowName: "ship", stepId: "gate", branchCount: 2, cwd, projectTrusted: true })(q, sig)).toMatchObject({ ok: false, outcome: "no-backend" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("pi-ai entry", () => {
  const model = (baseUrl = "https://api.typesafe.example") => ({ id: "jev-latest", provider: "typesafe", baseUrl, type: "classifier" });
  const registry = (over: any = {}) => ({
    getModelOfType: vi.fn((_t: string, p: string, id: string) => (p === "typesafe" && id === "jev-latest" ? model(over.baseUrl) : undefined)),
    hasConfiguredAuth: vi.fn(() => over.auth ?? true),
    classify: vi.fn(async () => over.result ?? ({
      stopReason: "stop", model: "jev-latest",
      answers: { decision: { type: "choice", choice: "done", probabilities: { done: 0.8, fix: 0.2 }, confidence: 0.8 } },
    })),
  });
  const loop = (h: string) => h === "127.0.0.1" || h === "localhost";

  it("classifies and normalises", async () => {
    const reg = registry();
    const r = await createPiAiEntry({ ref: "typesafe/jev-latest", registry: reg, blockOffMachine: false, isLoopbackHost: loop })(q, sig);
    expect(r).toMatchObject({ ok: true, answer: { label: "done", confidence: 0.8, model: "typesafe/jev-latest" } });
    expect((reg.classify.mock.calls[0] as any[])[1]).toEqual({ state: { task: "review it" }, questions: { decision: q.question } });
  });
  it("unknown classifier model → error", async () => {
    const r = await createPiAiEntry({ ref: "anthropic/claude", registry: registry(), blockOffMachine: false, isLoopbackHost: loop })(q, sig);
    expect(r).toMatchObject({ ok: false, outcome: "error" });
    expect((r as any).reason).toMatch(/not a known classifier/);
  });
  it("missing credential names the provider and sends nothing", async () => {
    const reg = registry({ auth: false });
    const r = await createPiAiEntry({ ref: "typesafe/jev-latest", registry: reg, blockOffMachine: false, isLoopbackHost: loop })(q, sig);
    expect(r).toMatchObject({ ok: false, outcome: "credentials" });
    expect((r as any).reason).toContain("typesafe");
    expect(reg.classify).not.toHaveBeenCalled();
  });
  it("privacy gate: hosted blocked, loopback allowed, no gate without config", async () => {
    const hosted = registry();
    const r1 = await createPiAiEntry({ ref: "typesafe/jev-latest", registry: hosted, blockOffMachine: true, isLoopbackHost: loop })(q, sig);
    expect(r1).toMatchObject({ ok: false, outcome: "off-machine" });
    expect(hosted.classify).not.toHaveBeenCalled();
    const local = registry({ baseUrl: "http://127.0.0.1:8080" });
    const r2 = await createPiAiEntry({ ref: "typesafe/jev-latest", registry: local, blockOffMachine: true, isLoopbackHost: loop })(q, sig);
    expect(r2.ok).toBe(true);
    const free = registry();
    expect((await createPiAiEntry({ ref: "typesafe/jev-latest", registry: free, blockOffMachine: false, isLoopbackHost: loop })(q, sig)).ok).toBe(true);
  });
  it("classify error result → error attempt", async () => {
    const reg = registry({ result: { stopReason: "error", errorMessage: "503", answers: {} } });
    const r = await createPiAiEntry({ ref: "typesafe/jev-latest", registry: reg, blockOffMachine: false, isLoopbackHost: loop })(q, sig);
    expect(r).toMatchObject({ ok: false, outcome: "error" });
    expect((r as any).reason).toContain("503");
  });
});

describe("llm caller", () => {
  const fauxModel = { id: "m1", provider: "faux", baseUrl: "https://x" };
  const mk = (text: string, over: any = {}) => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text }] }));
    const pi: any = { events: { emit: () => undefined } };
    const caller = createLlmCaller({
      pi, registry: { find: () => fauxModel, getAll: () => [fauxModel] }, complete,
      parentModel: { model: fauxModel as any }, modelFallback: "session", ...over,
    });
    return { caller, complete };
  };
  const args = { role: "@fast", state: JSON.stringify({ task: "t" }), questions: { decision: q.question }, signal: sig };

  it("one completion, parses the JSON answer, session fallback for the role", async () => {
    const { caller, complete } = mk('```json\n{"decision":{"choice":"done","probabilities":{"done":0.9,"fix":0.1}}}\n```');
    const r = await caller.call(args);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.model).toBe("faux/m1");
    expect((r.answers as any).decision.choice).toBe("done");
    const prompt = JSON.stringify((complete.mock.calls[0] as any[])[1]);
    expect(prompt).toContain("done");
    expect(prompt).toContain("review it");
  });
  it("unparseable output throws", async () => {
    const { caller } = mk("I think done");
    await expect(caller.call(args)).rejects.toThrow();
  });
  it("isLocal: only local providers on loopback", () => {
    const local = { id: "l", provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1" };
    const remoteOllama = { id: "l", provider: "ollama", baseUrl: "https://ollama.example.com" };
    const hosted = { id: "h", provider: "anthropic", baseUrl: "http://127.0.0.1:1" };
    const pick = (m: any) => mk("{}", { registry: { find: () => m, getAll: () => [m] }, parentModel: { model: m } }).caller;
    expect(pick(local).isLocal("ollama/l")).toBe(true);
    expect(pick(remoteOllama).isLocal("ollama/l")).toBe(false);
    expect(pick(hosted).isLocal("anthropic/h")).toBe(false);
  });
  it("isLocal is false when the role cannot be resolved", () => {
    const { caller } = mk("{}", { parentModel: undefined, registry: { find: () => undefined, getAll: () => [] } });
    expect(caller.isLocal("@nope")).toBe(false);
  });
});
