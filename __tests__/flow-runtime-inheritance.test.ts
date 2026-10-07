/**
 * flow-agents-inherit-model-runtime
 *
 * Written from the specs (subagent-spawn: "spawnAgent supplies model/auth via
 * the modelRuntime option"; flow-model-resolution: registry fallback), NOT
 * from the implementation. Every test drives the PRODUCTION wiring:
 *   activate(pi) -> session_start(ctx) -> flow:run -> flow:complete
 * with a REAL ModelRegistry wrapping a runtime whose provider exists only in
 * memory (exactly a provider registered via pi.registerProvider()).
 *
 * "Runtime" here means pi's providers + API keys table. The agent's MODEL is
 * never inherited — it always comes from the agent's own `model:` ref.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Record every createAgentSession call while still delegating to the real SDK.
const sessionCalls: any[] = [];
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    createAgentSession: vi.fn(async (opts: any) => {
      sessionCalls.push(opts);
      return real.createAgentSession(opts);
    }),
  };
});

import { activate } from "../extensions/flow-engine/index.js";
import { scriptFinish, lastUserText } from "./faux-harness.js";
import {
  makeParentSession,
  fakeExtensionHost,
  writeFlowFixture,
  agentMd,
  type ParentSession,
} from "./helpers/parent-session.js";

beforeEach(() => {
  sessionCalls.length = 0;
});

type Host = ReturnType<typeof fakeExtensionHost>;

/** Boot the real extension against a temp flows/agents fixture. */
async function boot(flows: Record<string, string>, agents: Record<string, string>): Promise<Host> {
  const host = fakeExtensionHost();
  activate(host.pi);
  const dirs = writeFlowFixture(flows, agents);
  await host.emit("flow:register-agents-dir", { dir: dirs.agentsDir });
  await host.emit("flow:register-flows-dir", { dir: dirs.flowsDir });
  return host;
}

/** Dispatch through the real flow:run path and await the terminal payload. */
async function runViaEvent(host: Host, flowName: string): Promise<any> {
  const done = host.next("flow:complete");
  await host.emit("flow:run", { flowName, task: "go" });
  return done;
}

/** Route faux turns by task text; queue enough copies for every turn. */
function respond(parent: ParentSession, pick: (task: string) => any, turns = 24) {
  const factory = (ctx: any) => pick(lastUserText(ctx));
  parent.faux.setResponses(Array.from({ length: turns }, () => factory));
}
const finishOk = () => scriptFinish({ status: "complete", summary: "ok" });

const why = (r: any) => JSON.stringify(r?.lastResult?.result ?? r);

const oneAgent = (model: string, flowKey = "rt/one") => ({
  flows: { [flowKey]: "name: one\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: do it\n" },
  agents: { worker: agentMd("worker", model) },
});

// ── 1. Fixtures ──────────────────────────────────────────────────────────────

describe("fixtures (1.1, 1.2)", () => {
  it("parent registry exposes the in-memory provider with resolvable auth", async () => {
    const parent = await makeParentSession();
    const model = parent.registry.find("rtprov", "m1");
    expect(model).toBeDefined();
    const auth = await parent.registry.getApiKeyAndHeaders(model);
    expect(auth.ok, JSON.stringify(auth)).toBe(true);
  });

  it("fake host has no pi.modelRegistry (matches the pi 1.x ExtensionAPI)", () => {
    const host = fakeExtensionHost();
    expect("modelRegistry" in host.pi).toBe(false);
  });
});

// ── 2. Runtime inheritance ───────────────────────────────────────────────────

describe("runtime-registered provider is usable by a flow agent", () => {
  it("2.1 agent on an in-memory provider succeeds via the production path", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status, why(result)).toBe("success");
    expect(parent.faux.state.callCount).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("2.2 the agent session receives the parent's exact runtime object", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    await runViaEvent(host, "rt:one");

    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0].modelRuntime).toBe(parent.runtime);
  }, 20_000);

  it("2.3 a provider registered AFTER session_start is visible (shared, not copied)", async () => {
    const parent = await makeParentSession();
    const f = oneAgent("late/m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    // Register a second in-memory provider on the SAME runtime after start.
    const late = await makeParentSession("late");
    const lateProvider = late.runtime.models.getProvider("late");
    parent.runtime.registerNativeProvider(lateProvider);
    respond(late, finishOk);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status, why(result)).toBe("success");
  }, 20_000);
});

describe("2.4 every agent-spawning step kind receives the same runtime", () => {
  it("(a) agent step + (b) autonomous fork decision + (c) looping agent-decision", async () => {
    const parent = await makeParentSession();
    let verifyRuns = 0;
    respond(parent, (task) => {
      if (/VERIFY/.test(task)) {
        verifyRuns++;
        return scriptFinish({ status: "complete", summary: "v", branch: verifyRuns < 2 ? "rework" : "done" });
      }
      if (/Pick a path|PICK/.test(task)) return scriptFinish({ status: "complete", summary: "picked", branch: "left" });
      return finishOk();
    });
    const flow = [
      "name: all-kinds",
      "description: d",
      "steps:",
      "  - id: build",
      "    type: agent",
      "    agent: worker",
      "    task: BUILD it",
      "  - id: verify",
      "    type: agent-decision",
      "    agent: worker",
      "    blockedBy: [build]",
      "    task: VERIFY attempt ${{loop.verify.iteration}}",
      "    branches:",
      "      rework: build",
      "      done: choose",
      "    max_iterations: 3",
      "  - id: choose",
      "    type: fork",
      "    question: PICK a path",
      "    options: [left, right]",
      "    branches:",
      "      left: left-step",
      "      right: right-step",
      "    agent: worker",
      "  - id: left-step",
      "    type: agent",
      "    agent: worker",
      "    task: LEFT work",
      "  - id: right-step",
      "    type: agent",
      "    agent: worker",
      "    task: RIGHT work",
      "",
    ].join("\n");
    const host = await boot({ "rt/kinds": flow }, { worker: agentMd("worker", "rtprov/m1") });
    await host.fire("session_start", parent.ctx);

    const result = await runViaEvent(host, "rt:kinds");

    expect(result.status, why(result)).toBe("success");
    expect(verifyRuns).toBe(2); // loop really re-entered
    // build x2, verify x2, fork decision x1, left-step x1
    expect(sessionCalls.length).toBeGreaterThanOrEqual(6);
    for (const call of sessionCalls) expect(call.modelRuntime).toBe(parent.runtime);
  }, 30_000);
});

describe("2.5 removed bootstrap options are never sent", () => {
  it("no authStorage / modelRegistry keys on any createAgentSession call", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    await runViaEvent(host, "rt:one");

    expect(sessionCalls.length).toBeGreaterThan(0);
    for (const call of sessionCalls) {
      expect("authStorage" in call).toBe(false);
      expect("modelRegistry" in call).toBe(false);
    }
  }, 20_000);
});

describe("2.6 the model is NEVER inherited from the parent", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["(a) unknown literal", "rtprov/does-not-exist", /does-not-exist/],
    ["(b) @role without a model:resolve handler", "\"@coding\"", /model:resolve/],
    ["(c) empty model", "\"\"", /model/i],
  ];
  for (const [label, ref, msg] of cases) {
    it(`${label} fails and never runs the parent's model`, async () => {
      const parent = await makeParentSession();
      respond(parent, finishOk);
      const f = oneAgent(ref);
      const host = await boot(f.flows, f.agents);
      await host.fire("session_start", { ...parent.ctx, model: parent.registry.find("rtprov", "m1") });

      const result = await runViaEvent(host, "rt:one");

      expect(result.status).not.toBe("success");
      expect(why(result)).toMatch(msg);
      expect(sessionCalls).toHaveLength(0);
      expect(parent.faux.state.callCount).toBe(0);
    }, 20_000);
  }
});

describe("2.7 model:resolve-resolved refs also get the runtime", () => {
  it("@fast resolved by a handler runs on the parent runtime", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const f = oneAgent("\"@fast\"");
    const host = await boot(f.flows, f.agents);
    host.pi.events.on("model:resolve", (probe: any) => {
      if (probe.ref !== "@fast") return;
      probe.model = parent.registry.find("rtprov", "m1");
      probe.resolved = "rtprov/m1";
    });
    await host.fire("session_start", parent.ctx);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status, why(result)).toBe("success");
    expect(sessionCalls[0]?.modelRuntime).toBe(parent.runtime);
  }, 20_000);
});

describe("2.9 flow:get-spawn-context exposes the runtime", () => {
  it("carries modelRuntime + modelRegistry, no authStorage", async () => {
    const parent = await makeParentSession();
    const host = await boot({}, {});
    await host.fire("session_start", parent.ctx);

    const data = await host.emit("flow:get-spawn-context", {});

    expect(data.modelRuntime).toBe(parent.runtime);
    expect(data.modelRegistry).toBe(parent.registry);
    expect("authStorage" in data).toBe(false);
  });
});

describe("2.10 a new session replaces the captured runtime", () => {
  it("runs on session B's runtime after B starts", async () => {
    const a = await makeParentSession("prova");
    const b = await makeParentSession("rtprov");
    respond(b, finishOk);
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", a.ctx);
    await host.fire("session_start", b.ctx);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status, why(result)).toBe("success");
    expect(sessionCalls[0]?.modelRuntime).toBe(b.runtime);
  }, 20_000);
});

// ── 2b. No-dashboard fallback resolves via the session registry ─────────────

describe("2b fallback resolves through the session registry (pi 1.x has no pi.modelRegistry)", () => {
  it("2b.1 literal provider/model resolves without 'Model registry unavailable'", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    const result = await runViaEvent(host, "rt:one");

    expect(why(result)).not.toMatch(/Model registry unavailable/);
    expect(result.status, why(result)).toBe("success");
  }, 20_000);

  it("2b.2 bare model id resolves via the session registry", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const f = oneAgent("m1");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status, why(result)).toBe("success");
  }, 20_000);

  it("2b.3 unknown literal fails naming the ref and listing known ids", async () => {
    const parent = await makeParentSession();
    const f = oneAgent("rtprov/nope");
    const host = await boot(f.flows, f.agents);
    await host.fire("session_start", parent.ctx);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status).not.toBe("success");
    expect(why(result)).toMatch(/rtprov\/nope/);
    expect(why(result)).not.toMatch(/Model registry unavailable/);
  }, 20_000);

  it("2b.4 no session and no registry fails with the actionable error, no session created", async () => {
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);

    const result = await runViaEvent(host, "rt:one");

    expect(result.status).not.toBe("success");
    expect(why(result)).toMatch(/registry unavailable/i);
    expect(sessionCalls).toHaveLength(0);
  }, 20_000);
});

// ── 2.8 / 3.3: no runtime available -> default runtime, nothing crashes ─────

describe("2.8 programmatic run without a parent runtime uses pi's default runtime", () => {
  it("createAgentSession is called WITHOUT a modelRuntime key", async () => {
    const { runFlow } = await import("../extensions/flow-engine/flow-execution.js");
    const parent = await makeParentSession();
    const agent = { name: "worker", description: "d", model: "rtprov/m1", tools: [], systemPrompt: "x", source: "<t>" };
    const result = await runFlow({
      flow: { name: "p", description: "d", source: "<t>", steps: [{ stepType: "agent", id: "s", agent: "worker", task: "t" }] } as any,
      task: "t",
      cwd: process.cwd(),
      modelRegistry: parent.registry,
      pi: { events: { emit: () => undefined, on: () => undefined } } as any,
      getAgent: () => agent,
      askUser: async () => ({ answer: "" }),
    } as any);

    expect(sessionCalls.length).toBeGreaterThan(0);
    for (const call of sessionCalls) expect("modelRuntime" in call).toBe(false);
    // In-memory-only provider is (correctly) unknown to the default disk runtime.
    expect(result.status).not.toBe("success");
  }, 20_000);
});

describe("3.3 unreadable runtime (simulated pi rename) degrades to the default runtime", () => {
  it("session_start does not throw and agents get no modelRuntime key", async () => {
    const parent = await makeParentSession();
    // A registry facade WITHOUT the private runtime field.
    const facade = {
      find: (p: string, id: string) => parent.registry.find(p, id),
      getAll: () => parent.registry.getAll(),
    };
    const f = oneAgent("rtprov/m1");
    const host = await boot(f.flows, f.agents);
    await expect(host.fire("session_start", { modelRegistry: facade, hasUI: false })).resolves.toBeUndefined();

    await runViaEvent(host, "rt:one");

    expect(sessionCalls.length).toBeGreaterThan(0);
    for (const call of sessionCalls) expect("modelRuntime" in call).toBe(false);
  }, 20_000);
});

// ── 4.5: thinking: max frontmatter reaches the session ───────────────────────

describe("4.5 thinking: max in agent frontmatter", () => {
  it("is passed to createAgentSession and overrides a :high suffix", async () => {
    const parent = await makeParentSession();
    respond(parent, finishOk);
    const host = await boot(
      { "rt/one": "name: one\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: do it\n" },
      { worker: agentMd("worker", "rtprov/m1:high", "max") },
    );
    await host.fire("session_start", parent.ctx);

    await runViaEvent(host, "rt:one");

    expect(sessionCalls[0]?.thinkingLevel).toBe("max");
  }, 20_000);
});
