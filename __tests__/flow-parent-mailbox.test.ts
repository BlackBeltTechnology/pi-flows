/**
 * Spec tests for change add-flow-parent-mailbox (flow-parent-questions,
 * flow-session-control, flow-run-dispatch, subagent-spawn deltas).
 *
 * Drives the REAL extension (`activate` → `session_start` → tools / events)
 * with real agent sessions on a scripted faux provider. The parent session is
 * the test: it calls `flow_run` / `flow_control` like the main model would and
 * reads what the engine pushes with `pi.sendMessage`.
 *
 * Agents are scripted by task markers: `@@CALL <tool> <json>@@` makes the
 * agent call that tool; after a tool result the agent finishes with
 * `GOT:<tool>:<text>` (or `ERR:...` for an error result), so the test sees
 * exactly what the agent received.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const autonomous = vi.hoisted(() => ({ on: false }));
vi.mock("../extensions/autonomous-mode.js", () => ({
  isAutonomousMode: () => autonomous.on,
  setAutonomousMode: (v: boolean) => { autonomous.on = v; },
  activate: () => undefined,
}));

import { activate } from "../extensions/flow-engine/index.js";
import { lastUserText, scriptFinish } from "./faux-harness.js";
import { fakeExtensionHost, makeParentSession, writeFlowFixture } from "./helpers/parent-session.js";

// ---- fixtures ---------------------------------------------------------------

const agentMd = (name: string, tools = "read") =>
  `---\nname: ${name}\ndescription: ${name}\nmodel: rtprov/m1\ntools: ${tools}\n---\nYou are ${name}.\n`;

/** One agent step whose task scripts a tool call. */
const call = (tool: string, args: unknown) => `'@@CALL ${tool} ${JSON.stringify(args)}@@'`;

function responder(context: any): any {
  const msgs = context?.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (last?.role === "toolResult") {
    const text = (last.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
    return scriptFinish({ status: "complete", summary: `${last.isError ? "ERR" : "GOT"}:${last.toolName}:${text}` });
  }
  const task = lastUserText(context);
  const m = /@@CALL (\w+) (\{.*?\})@@/s.exec(task);
  if (m) return fauxAssistantMessage([fauxToolCall(m[1], JSON.parse(m[2]))]);
  // Decision/decider turns: pick `fix`, or an invalid label when steered with INVALIDATE.
  if (/Branches \(call finish|You did not call/.test(task)) {
    return scriptFinish({ status: "complete", summary: "decided", branch: /INVALIDATE/.test(task) ? "nope" : "fix" });
  }
  return scriptFinish({ status: "complete", summary: "plain" });
}

const CHANNELS = ["flow:question", "flow:answer", "flow:complete", "flow:flow-started"];

async function boot(
  flows: Record<string, string>,
  agents: Record<string, string>,
  ctxExtra: Record<string, unknown> = {},
  files: Record<string, string> = {},
) {
  const parent = await makeParentSession();
  parent.faux.setResponses(Array.from({ length: 80 }, () => responder));
  const host = fakeExtensionHost();
  activate(host.pi);
  const dirs = writeFlowFixture(flows, agents);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dirs.flowsDir, rel), body, "utf8");
  await host.emit("flow:register-agents-dir", { dir: dirs.agentsDir });
  await host.emit("flow:register-flows-dir", { dir: dirs.flowsDir });
  const events: Array<{ name: string; data: any }> = [];
  for (const name of CHANNELS) host.pi.events.on(name, (data: any) => events.push({ name, data }));
  await host.fire("session_start", { ...parent.ctx, ...ctxExtra });
  const until = (pred: () => boolean, ms = 8000) => new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error("timeout")) : setTimeout(tick, 20));
    tick();
  });
  const of = (name: string) => events.filter((e) => e.name === name).map((e) => e.data);
  const mail = () => host.sent.filter((s) => s.message?.customType === "flow:mail");
  const control = (params: any, signal?: AbortSignal) => host.callTool("flow_control", params, signal);
  const run = (params: any) => host.callTool("flow_run", params);
  const complete = () => until(() => of("flow:complete").length > 0, 15000).then(() => of("flow:complete")[0]);
  return { host, parent, events, of, mail, control, run, until, complete };
}

const text = (r: any) => (r?.content ?? []).map((b: any) => b.text ?? "").join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { autonomous.on = false; });

const oneAsk = (args: unknown, tools = "read") => ({
  flows: { "t/ask": `name: ask\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: ${call("ask_parent", args)}\n` },
  agents: { worker: agentMd("worker", tools) },
});

// ---- flow_run ---------------------------------------------------------------

describe("flow_run", () => {
  it("starts a run and returns its runId", async () => {
    const { flows, agents } = { flows: { "t/plain": "name: p\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: hi\n" }, agents: { worker: agentMd("worker") } };
    const t = await boot(flows, agents);
    const r = await t.run({ flow: "t:plain", task: "go" });
    expect(r.isError).toBeFalsy();
    expect(r.details.runId).toBeTruthy();
    const done = await t.complete();
    expect(done.runId).toBe(r.details.runId);
  });

  it("declines while a run is active with the engine's reason, never the active run's id", async () => {
    const { flows, agents } = oneAsk({ question: "hold" });
    const t = await boot(flows, agents);
    const first = await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    const second = await t.run({ flow: "t:ask", task: "go" });
    expect(second.isError).toBe(true);
    expect(text(second)).toMatch(/already running/i);
    expect(JSON.stringify(second)).not.toContain(first.details.runId);
    const rejection = t.of("flow:complete").find((c) => c.status === "rejected");
    expect(rejection?.reason).toBe(text(second));
    await t.control({ action: "cancel" });
  });

  it("rejects a missing task on a task_required flow without dispatching", async () => {
    const t = await boot({ "t/req": "name: r\ndescription: d\ntask_required: true\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: hi\n" }, { worker: agentMd("worker") });
    const r = await t.run({ flow: "t:req" });
    expect(r.isError).toBe(true);
    expect(t.of("flow:flow-started")).toHaveLength(0);
    expect(t.of("flow:complete")).toHaveLength(0);
  });

  it("declines invalid typed inputs before start", async () => {
    const t = await boot({ "t/in": "name: i\ndescription: d\ninputs:\n  ref: { type: string, required: true }\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: hi\n" }, { worker: agentMd("worker") });
    const r = await t.run({ flow: "t:in", task: "go" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/ref/);
    expect(t.of("flow:flow-started")).toHaveLength(0);
  });
});

describe("flow:run typed inputs are a pre-start check", () => {
  it("a missing required input declines the dispatch with no flow-started", async () => {
    const t = await boot({ "t/in": "name: i\ndescription: d\ninputs:\n  ref: { type: string, required: true }\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: hi\n" }, { worker: agentMd("worker") });
    await t.host.emit("flow:run", { flowName: "t:in", task: "go" });
    const done = await t.complete();
    expect(done.status).toBe("rejected");
    expect(done.reason).toMatch(/ref/);
    expect(t.of("flow:flow-started")).toHaveLength(0);
  });
});

// ---- ask_parent ---------------------------------------------------------------

describe("ask_parent", () => {
  it("round trip: question pushed, parent replies, agent receives the answer, events in order", async () => {
    const { flows, agents } = oneAsk({ question: "Use v2 API?" });
    const t = await boot(flows, agents);
    const r = await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.mail().length === 1, 5000);
    const push = t.mail()[0];
    expect(push.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(push.message.display).toBe(true);
    const q = t.of("flow:question")[0];
    expect(q).toMatchObject({ runId: r.details.runId, stepId: "s", agent: "worker", question: "Use v2 API?" });
    expect(String(push.message.content)).toContain(q.question_id);

    const rep = await t.control({ action: "reply", question_id: q.question_id, answer: "yes, v2" });
    expect(rep.details.outcomes).toEqual([{ question_id: q.question_id, outcome: "answered" }]);
    const done = await t.complete();
    expect(done.status).toBe("success");
    expect(done.results.s.summary).toBe("GOT:ask_parent:yes, v2");
    const a = t.of("flow:answer")[0];
    expect(a).toMatchObject({ runId: r.details.runId, question_id: q.question_id, via: "reply" });
    const order = t.events.map((e) => e.name).filter((n) => n !== "flow:flow-started");
    expect(order).toEqual(["flow:question", "flow:answer", "flow:complete"]);
  });

  it("is available despite a tools allowlist and with autonomous mode on", async () => {
    autonomous.on = true;
    const { flows, agents } = oneAsk({ question: "q" }, "read, grep");
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "cancel" });
  });

  it("parks without a timeout (still open after a while)", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await sleep(1500);
    const st = await t.control({ action: "status" });
    expect(st.details.questions).toHaveLength(1);
    expect(t.of("flow:answer")).toHaveLength(0);
    await t.control({ action: "cancel" });
  });

  it("returns the custom default on timeout and rejects a late reply", async () => {
    const { flows, agents } = oneAsk({ question: "q", timeout_s: 1, default: "Skip the migration" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    const done = await t.complete();
    expect(done.results.s.summary).toBe("GOT:ask_parent:Skip the migration");
    const q = t.of("flow:question")[0];
    expect(t.of("flow:answer")[0]).toMatchObject({ question_id: q.question_id, via: "timeout" });
    const late = await t.control({ action: "reply", question_id: q.question_id, answer: "x" });
    expect(late.details.outcomes[0].outcome).toBe("not_pending");
  });

  it("returns the built-in steering text on timeout without a default", async () => {
    const { flows, agents } = oneAsk({ question: "q", timeout_s: 1 });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    const done = await t.complete();
    expect(done.results.s.summary).toMatch(/^GOT:ask_parent:.*did not answer.*decide.*assumption/is);
  });

  it("invalid arguments return an error result and open no question", async () => {
    const { flows, agents } = oneAsk({ question: "x", default: "y" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    const done = await t.complete();
    expect(done.results.s.summary).toMatch(/^ERR:ask_parent:/);
    expect(t.of("flow:question")).toHaveLength(0);
  });

  it("validates option answers; multi-select delivers every selection", async () => {
    const { flows, agents } = oneAsk({ question: "pick", options: ["a", "b", "c"], multiSelect: true });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    const q = t.of("flow:question")[0];
    const bad = await t.control({ action: "reply", question_id: q.question_id, answer: "z" });
    expect(bad.details.outcomes[0].outcome).toBe("invalid");
    expect(JSON.stringify(bad.details.outcomes[0])).toContain("a");
    const ok = await t.control({ action: "reply", question_id: q.question_id, answer: ["a", "c"] });
    expect(ok.details.outcomes[0].outcome).toBe("answered");
    const done = await t.complete();
    expect(done.results.s.summary).toMatch(/GOT:ask_parent:.*a.*c/);
  });

  it("the engine's ask_parent replaces a same-named extension tool", async () => {
    const { flows, agents } = oneAsk({ question: "real?" }, "read, ask_parent");
    const t = await boot(flows, agents);
    await t.host.emit("flow:register-tool", { tool: { name: "ask_parent", label: "x", description: "fake", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "FAKE" }], details: {} }) } });
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "reply", question_id: t.of("flow:question")[0].question_id, answer: "yes" });
    const done = await t.complete();
    expect(done.results.s.summary).toBe("GOT:ask_parent:yes");
  });
});

describe("parallel questions", () => {
  const flows = {
    "t/par": [
      "name: par", "description: d", "steps:",
      `  - id: a\n    type: agent\n    agent: worker\n    task: ${call("ask_parent", { question: "from a" })}`,
      `  - id: b\n    type: agent\n    agent: worker\n    task: ${call("ask_parent", { question: "from b" })}`,
    ].join("\n") + "\n",
  };

  it("two parallel asks: one batched push, distinct ids, independent resume, multi-reply", async () => {
    const t = await boot(flows, { worker: agentMd("worker") });
    await t.run({ flow: "t:par", task: "go" });
    await t.until(() => t.of("flow:question").length === 2);
    await sleep(1300);
    expect(t.mail()).toHaveLength(1);
    const [qa, qb] = ["a", "b"].map((s) => t.of("flow:question").find((q) => q.stepId === s));
    expect(qa.question_id).not.toBe(qb.question_id);
    expect(String(t.mail()[0].message.content)).toContain(qa.question_id);
    expect(String(t.mail()[0].message.content)).toContain(qb.question_id);

    await t.control({ action: "reply", question_id: qb.question_id, answer: "B!" });
    await t.until(() => t.of("flow:answer").length === 1);
    const st = await t.control({ action: "status" });
    expect(st.details.questions.map((q: any) => q.question_id)).toEqual([qa.question_id]);

    const rep = await t.control({ action: "reply", replies: [{ question_id: qa.question_id, answer: "A!" }, { question_id: "q-nope", answer: "x" }] });
    expect(rep.details.outcomes).toEqual([
      { question_id: qa.question_id, outcome: "answered" },
      { question_id: "q-nope", outcome: "not_pending" },
    ]);
    const done = await t.complete();
    expect(done.results.a.summary).toBe("GOT:ask_parent:A!");
    expect(done.results.b.summary).toBe("GOT:ask_parent:B!");
  });

  it("fan-out instances record their item index", async () => {
    const fan = {
      "t/fan": [
        "name: fan", "description: d", "steps:",
        "  - id: decide\n    type: code-decision\n    multi: true\n    branches:\n      go:\n        to: w\n        for_each: '[\"x\",\"y\",\"z\"]'",
        `  - id: w\n    type: agent\n    agent: worker\n    task: ${call("ask_parent", { question: "item" })}`,
      ].join("\n") + "\n",
    };
    const t = await boot(fan, { worker: agentMd("worker") }, {}, {
      "t/fan/decide.ts": `export default async () => ({ branch: "go" });\n`,
    });
    await t.run({ flow: "t:fan", task: "go" });
    await t.until(() => t.of("flow:question").length === 3);
    expect(new Set(t.of("flow:question").map((q) => q.item?.index))).toEqual(new Set([0, 1, 2]));
    await t.control({ action: "cancel" });
  });
});

// ---- wait ---------------------------------------------------------------------

describe("flow_control wait", () => {
  it("returns a question that opens while waiting, and no push is sent for it", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    const w = await t.control({ action: "wait", timeout_s: 10 });
    expect(w.details.questions).toHaveLength(1);
    await sleep(1300);
    expect(t.mail()).toHaveLength(0);
    // Returned by wait → does not end a later wait.
    const t0 = Date.now();
    const w2 = await t.control({ action: "wait", timeout_s: 1 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(w2.details.questions ?? []).toHaveLength(0);
    expect(w2.details.timedOut).toBe(true);
    await t.control({ action: "reply", question_id: w.details.questions[0].question_id, answer: "ok" });
    const w3 = await t.control({ action: "wait", timeout_s: 10 });
    expect(w3.details.outcome?.status).toBe("success");
    const w4 = await t.control({ action: "wait", timeout_s: 10 });
    expect(w4.details.nothingToWait).toBe(true);
  });

  it("returns a pushed-but-not-yet-waited question at once", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.mail().length === 1, 5000);
    const t0 = Date.now();
    const w = await t.control({ action: "wait", timeout_s: 10 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(w.details.questions).toHaveLength(1);
    await t.control({ action: "cancel" });
  });

  it("stops when its tool call is aborted; the run keeps going", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "wait", timeout_s: 1 }); // consume the question
    const ac = new AbortController();
    const p = t.control({ action: "wait", timeout_s: 30 }, ac.signal);
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    const st = await t.control({ action: "status" });
    expect(st.details.runId).toBeTruthy();
    await t.control({ action: "cancel" });
  });
});

// ---- cancel / status / detached ----------------------------------------------

describe("cancel and scope", () => {
  it("cancel closes open questions before flow:complete and the run ends aborted", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "cancel" });
    const done = await t.complete();
    expect(done.status).toBe("aborted");
    const names = t.events.map((e) => e.name);
    expect(names.indexOf("flow:answer")).toBeLessThan(names.indexOf("flow:complete"));
    expect(t.of("flow:answer")[0].via).toBe("cancel");
    const late = await t.control({ action: "reply", question_id: t.of("flow:question")[0].question_id, answer: "x" });
    expect(late.details.outcomes[0].outcome).toBe("not_pending");
  });

  it("a hard-fail halt closes a sibling's open question", async () => {
    const flows = {
      "t/halt": [
        "name: h", "description: d", "steps:",
        `  - id: a\n    type: agent\n    agent: worker\n    task: ${call("ask_parent", { question: "q" })}`,
        "  - id: b\n    type: agent\n    agent: boom\n    task: crash",
      ].join("\n") + "\n",
    };
    const t = await boot(flows, { worker: agentMd("worker"), boom: agentMd("boom") });
    // `boom` answers with a provider error → soft failure without on_error → halt.
    // It fails only once `a`'s question is open, so the halt hits a parked asker.
    t.parent.faux.setResponses(Array.from({ length: 80 }, () => async (ctx: any) => {
      if (!/crash/.test(lastUserText(ctx))) return responder(ctx);
      await t.until(() => t.of("flow:question").length === 1);
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });
    }));
    await t.run({ flow: "t:halt", task: "go" });
    const done = await t.complete();
    expect(done.status).not.toBe("success");
    const q = t.of("flow:question");
    expect(q).toHaveLength(1);
    expect(t.of("flow:answer")[0]).toMatchObject({ question_id: q[0].question_id, via: "cancel" });
  });

  it("detached flow:run: no ask_parent, no question, no push; flow_control reports no attached run", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.host.emit("flow:run", { flowName: "t:ask", task: "go" });
    const done = await t.complete();
    expect(done.results.s.summary).toMatch(/^ERR:ask_parent:/);
    expect(t.of("flow:question")).toHaveLength(0);
    expect(t.mail()).toHaveLength(0);
    const st = await t.control({ action: "status" });
    expect(text(st)).toMatch(/no parent-attached run/i);
  });

  it("flow:run with notifyParent: true is attached", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    await t.host.emit("flow:run", { flowName: "t:ask", task: "go", notifyParent: true });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "cancel" });
  });

  it("a run end is pushed for attached runs only", async () => {
    const flows = { "t/plain": "name: p\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: hi\n" };
    const t = await boot(flows, { worker: agentMd("worker") });
    await t.run({ flow: "t:plain", task: "go" });
    await t.complete();
    await t.until(() => t.mail().length === 1, 4000);
    expect(String(t.mail()[0].message.content)).toMatch(/success/);
  });
});

// ---- forks ----------------------------------------------------------------------

const forkFlow = (extra = "", opts = "[fix, skip]") => ({
  "t/fork": [
    "name: f", "description: d", "steps:",
    `  - id: choose\n    type: fork\n    question: "Fix or skip?"\n    options: ${opts}\n    branches:\n      fix: do-fix\n      skip: do-skip${extra}`,
    "  - id: do-fix\n    type: agent\n    agent: worker\n    task: fixing",
    "  - id: do-skip\n    type: agent\n    agent: worker\n    task: skipping",
  ].join("\n") + "\n",
});

describe("fork steps ask the parent", () => {
  it("parent picks a branch (autonomous on is ignored for attached runs); notes are kept", async () => {
    autonomous.on = true;
    const t = await boot(forkFlow(), { worker: agentMd("worker") });
    await t.run({ flow: "t:fork", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    const q = t.of("flow:question")[0];
    expect(q).toMatchObject({ kind: "fork", stepId: "choose", options: ["fix", "skip"] });
    const bad = await t.control({ action: "reply", question_id: q.question_id, answer: "maybe" });
    expect(bad.details.outcomes[0].outcome).toBe("invalid");
    const dec = await t.control({ action: "reply", question_id: q.question_id, decide: true });
    expect(dec.details.outcomes[0].outcome).toBe("invalid"); // no decider
    await t.control({ action: "reply", question_id: q.question_id, answer: "skip", notes: "flaky test" });
    const done = await t.complete();
    expect(done.results["do-skip"].status).not.toBe("skipped");
    expect(done.results["do-fix"].status).toBe("skipped");
    expect(done.forks.choose).toMatchObject({ answer: "skip", notes: "flaky test" });
  });

  it("multi-select fork takes every chosen branch", async () => {
    const t = await boot(forkFlow("\n    multiSelect: true"), { worker: agentMd("worker") });
    await t.run({ flow: "t:fork", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "reply", question_id: t.of("flow:question")[0].question_id, answer: ["fix", "skip"] });
    const done = await t.complete();
    expect(done.results["do-fix"].status).not.toBe("skipped");
    expect(done.results["do-skip"].status).not.toBe("skipped");
    expect(typeof done.forks.choose.answer).toBe("string");
  });

  it("a fork with ask_timeout_s takes ask_default on timeout", async () => {
    const t = await boot(forkFlow("\n    ask_timeout_s: 1\n    ask_default: skip"), { worker: agentMd("worker") });
    await t.run({ flow: "t:fork", task: "go" });
    const done = await t.complete();
    expect(done.results["do-fix"].status).toBe("skipped");
    expect(t.of("flow:answer")[0].via).toBe("timeout");
  });

  it("a closed fork question runs no branch", async () => {
    const t = await boot(forkFlow(), { worker: agentMd("worker") });
    await t.run({ flow: "t:fork", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "cancel" });
    const done = await t.complete();
    expect(done.status).toBe("aborted");
    for (const s of ["do-fix", "do-skip"]) expect(done.results?.[s]?.status ?? "skipped").not.toBe("complete");
  });

  it("detached fork with autonomous off takes the first option without a question", async () => {
    const t = await boot(forkFlow(), { worker: agentMd("worker") });
    await t.host.emit("flow:run", { flowName: "t:fork", task: "go" });
    const done = await t.complete();
    expect(t.of("flow:question")).toHaveLength(0);
    expect(done.results["do-skip"].status).toBe("skipped");
  });

  it("delegation: decide resolves through the decider without touching autonomous mode", async () => {
    const t = await boot(forkFlow("\n    agent: router"), { worker: agentMd("worker"), router: agentMd("router") });
    await t.run({ flow: "t:fork", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    const q = t.of("flow:question")[0];
    expect(q.canDecide).toBe(true);
    await t.control({ action: "reply", question_id: q.question_id, decide: true, notes: "prefer fix" });
    const done = await t.complete();
    expect(done.status).toBe("success");
    expect(done.results["do-fix"].status).not.toBe("skipped");
    expect(autonomous.on).toBe(false);
  });

  it("exhausted delegation without on_error is re-asked once, options only", async () => {
    const t = await boot(forkFlow("\n    agent: router\n    allowCustom: true"), { worker: agentMd("worker"), router: agentMd("router") });
    await t.run({ flow: "t:fork", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "reply", question_id: t.of("flow:question")[0].question_id, decide: true, notes: "INVALIDATE" });
    await t.until(() => t.of("flow:question").length === 2, 15000);
    const re = t.of("flow:question")[1];
    expect(re).toMatchObject({ stepId: "choose", canDecide: false, allowCustom: false });
    const dec = await t.control({ action: "reply", question_id: re.question_id, decide: true });
    expect(dec.details.outcomes[0].outcome).toBe("invalid");
    await t.control({ action: "reply", question_id: re.question_id, answer: "fix" });
    const done = await t.complete();
    expect(done.results["do-fix"].status).not.toBe("skipped");
  });

  it("exhausted delegation with on_error routes there without a new question", async () => {
    const flows = forkFlow("\n    agent: router\n    on_error: recover");
    flows["t/fork"] += "  - id: recover\n    type: agent\n    agent: worker\n    task: recovering\n";
    const t = await boot(flows, { worker: agentMd("worker"), router: agentMd("router") });
    await t.run({ flow: "t:fork", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "reply", question_id: t.of("flow:question")[0].question_id, decide: true, notes: "INVALIDATE" });
    const done = await t.complete();
    expect(t.of("flow:question")).toHaveLength(1);
    expect(done.results.recover?.status).not.toBe("skipped");
  });
});

// ---- agent-decision exclusion & extension prompts -------------------------------

describe("who can ask", () => {
  it("an agent-decision agent has no ask_parent", async () => {
    const flows = {
      "t/dec": [
        "name: d", "description: d", "steps:",
        `  - id: pick\n    type: agent-decision\n    agent: router\n    task: ${call("ask_parent", { question: "may I?" })}\n    branches:\n      go: done`,
        "  - id: done\n    type: agent\n    agent: worker\n    task: hi",
      ].join("\n") + "\n",
    };
    const t = await boot(flows, { router: agentMd("router"), worker: agentMd("worker") });
    // router: tool result (blocked) → finish with the branch.
    t.parent.faux.setResponses(Array.from({ length: 80 }, () => (ctx: any) => {
      const msgs = ctx?.messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.role === "toolResult") return scriptFinish({ status: "complete", summary: last.isError ? "blocked" : "asked", branch: "go" });
      return responder(ctx);
    }));
    await t.run({ flow: "t:dec", task: "go" });
    await t.complete();
    expect(t.of("flow:question")).toHaveLength(0);
  });

  it("an extension tool's ctx.ui.confirm becomes a parent question", async () => {
    const { flows, agents } = oneAsk({}, "read, guarded_write");
    flows["t/ask"] = flows["t/ask"].replace(/task: .*/, `task: ${call("guarded_write", {})}`);
    const t = await boot(flows, agents);
    await t.host.emit("flow:register-tool", {
      tool: {
        name: "guarded_write", label: "gw", description: "asks before writing",
        parameters: { type: "object", properties: {} },
        execute: async (_id: string, _p: any, _s: any, _u: any, ctx: any) => {
          const ok = await ctx.ui.confirm("Overwrite?", "file.txt");
          return { content: [{ type: "text", text: ok ? "wrote" : "kept" }], details: {} };
        },
      },
    });
    await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    const q = t.of("flow:question")[0];
    expect(q).toMatchObject({ kind: "extension", stepId: "s" });
    await t.control({ action: "reply", question_id: q.question_id, answer: "yes" });
    const done = await t.complete();
    expect(done.results.s.summary).toBe("GOT:guarded_write:wrote");
  });
});

// ---- persistence, markers, reconciliation ------------------------------------

describe("persistence", () => {
  const flowEvents = (t: any) => t.host.entries.filter((e: any) => e.customType === "flow-event").map((e: any) => e.data);

  it("question events are persisted in emission order before flow_complete, with the run id", async () => {
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents);
    const r = await t.run({ flow: "t:ask", task: "go" });
    await t.until(() => t.of("flow:question").length === 1);
    await t.control({ action: "reply", question_id: t.of("flow:question")[0].question_id, answer: "ok" });
    await t.complete();
    const recs = flowEvents(t);
    const types = recs.map((x: any) => x.eventType);
    const iq = types.indexOf("flow_question");
    const ia = types.indexOf("flow_answer");
    const ic = types.indexOf("flow_complete");
    expect(iq).toBeGreaterThanOrEqual(0);
    expect(iq).toBeLessThan(ia);
    expect(ia).toBeLessThan(ic);
    expect(recs[iq].seq).toBeLessThan(recs[ia].seq);
    expect(recs[iq].flowRunId).toBe(r.details.runId);
  });

  it("orphan reconciliation closes a persisted open question before the terminal record", async () => {
    const R = "run-orphan";
    const stored = [
      { type: "custom", customType: "flow-event", data: { seq: 0, eventType: "flow_started", flowRunId: R, data: { flowName: "t:ask", runId: R } } },
      { type: "custom", customType: "flow-event", data: { seq: 1, eventType: "flow_question", flowRunId: R, data: { question_id: "q-orphan", runId: R } } },
    ];
    const sm = { getEntries: () => stored, appendMessage: () => undefined };
    const { flows, agents } = oneAsk({ question: "q" });
    const t = await boot(flows, agents, { sessionManager: sm });
    const recs = flowEvents(t);
    const types = recs.map((x: any) => x.eventType);
    const ia = types.indexOf("flow_answer");
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(recs[ia].data).toMatchObject({ question_id: "q-orphan", via: "cancel" });
    expect(recs[ia].flowRunId).toBe(R);
    expect(ia).toBeLessThan(types.indexOf("flow_complete"));
  });

  it("lifecycle markers wait for the parent's turn to end", async () => {
    let idle = true;
    const appended: any[] = [];
    const sm = { getEntries: () => [], appendMessage: (m: any) => appended.push(m) };
    const flows = { "t/plain": "name: p\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: hi\n" };
    const t = await boot(flows, { worker: agentMd("worker") }, { sessionManager: sm, isIdle: () => idle });
    await t.run({ flow: "t:plain", task: "go" });
    await t.until(() => appended.length === 1); // start marker (idle)
    idle = false; // a parent turn is in progress when the run ends
    await t.complete();
    await sleep(200);
    expect(appended).toHaveLength(1);
    idle = true;
    await t.host.fire("agent_end", { ...t.parent.ctx, sessionManager: sm, isIdle: () => idle });
    expect(appended).toHaveLength(2);
    expect(appended[1].content[0].text).toMatch(/\[flow\] .*success/);
  });
});

// ---- validation -----------------------------------------------------------------

import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

describe("validation", () => {
  const forkYaml = (extra: string) => forkFlow(extra)["t/fork"];
  const agentsMap = () => new Map([["worker", parseAgentString(agentMd("worker"), "<t>")]]);
  const errors = (yaml: string) =>
    validateFlowContent(yaml, agentsMap, () => true).diagnostics.filter((d: any) => d.severity === "error");

  it("ask_default must be one of the options", () => {
    const y = forkYaml("\n    ask_timeout_s: 30\n    ask_default: maybe");
    expect(() => parseFlowYamlString(y, "<t>")).toThrow(/ask_default/);
    expect(errors(y).some((d: any) => /ask_default/.test(d.message))).toBe(true);
  });

  it("ask_timeout_s and ask_default come together, timeout within 1..86400", () => {
    expect(() => parseFlowYamlString(forkYaml("\n    ask_timeout_s: 30"), "<t>")).toThrow(/ask_default/);
    expect(() => parseFlowYamlString(forkYaml("\n    ask_default: skip"), "<t>")).toThrow(/ask_timeout_s/);
    expect(() => parseFlowYamlString(forkYaml("\n    ask_timeout_s: 0\n    ask_default: skip"), "<t>")).toThrow(/ask_timeout_s/);
    expect(() => parseFlowYamlString(forkYaml("\n    ask_timeout_s: 30\n    ask_default: skip"), "<t>")).not.toThrow();
  });

  it("ask_parent is a known agent tool", () => {
    const diags = validateAgentContent(agentMd("worker", "read, ask_parent")).diagnostics;
    expect(diags.filter((d: any) => d.severity === "error")).toEqual([]);
  });
});
