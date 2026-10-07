/**
 * Thinking level carried by the model ref (role `:level` via model:resolve, or
 * a literal `provider/model:level` suffix) MUST reach the agent session on
 * agent steps, and pi's `defaultThinkingLevel` setting MUST NOT override it.
 *
 * Precedence (spec flow-model-resolution):
 *   agent `thinking:` frontmatter  >  ref level (role / suffix)  >  pi defaults
 *
 * Production path: activate(pi) -> session_start -> flow:run. The pi config dir
 * is a temp dir whose settings.json sets `defaultThinkingLevel: "medium"`
 * (mirrors a real user setup), and assertions check the level the MODEL
 * actually received on its request, not only the session options.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { scriptFinish, lastUserText } from "./faux-harness.js";
import {
  makeParentSession,
  bootExtension,
  runFlowViaEvent,
  agentMd,
  type ParentSession,
} from "./helpers/parent-session.js";

const ENV = "PI_CODING_AGENT_DIR";
let savedAgentDir: string | undefined;

beforeAll(() => {
  savedAgentDir = process.env[ENV];
  const dir = mkdtempSync(join(tmpdir(), "pi-flows-thk-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "medium" }), "utf8");
  process.env[ENV] = dir;
});

afterAll(() => {
  if (savedAgentDir === undefined) delete process.env[ENV];
  else process.env[ENV] = savedAgentDir;
});

beforeEach(() => {
  sessionCalls.length = 0;
});

/** Parent session with a reasoning-capable in-memory model; records the
 *  `reasoning` option of every request the model receives (by task text). */
async function reasoningParent() {
  const parent = await makeParentSession("rtprov", [{ id: "m1", reasoning: true }]);
  const received: Array<{ task: string; reasoning: unknown }> = [];
  const factory = (ctx: any, opts: any) => {
    const task = lastUserText(ctx);
    received.push({ task, reasoning: opts?.reasoning });
    if (/DECIDE/.test(task)) return scriptFinish({ status: "complete", summary: "d", branch: "done" });
    return scriptFinish({ status: "complete", summary: "ok" });
  };
  parent.faux.setResponses(Array.from({ length: 16 }, () => factory));
  return { parent, received };
}

/** A model:resolve handler mapping `@fast` -> rtprov/m1 at `level`. */
function roleHandler(parent: ParentSession, level: string) {
  return (probe: any) => {
    if (probe.ref !== "@fast") return;
    probe.model = parent.registry.find("rtprov", "m1");
    probe.resolved = "rtprov/m1";
    probe.thinkingLevel = level;
  };
}

const ONE_STEP = "name: one\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: WORK it\n";
const why = (r: any) => JSON.stringify(r?.lastResult?.result ?? r);

describe("control: pi defaultThinkingLevel applies only when no level is given", () => {
  it("agent with no level anywhere runs at the settings default (medium)", async () => {
    const { parent, received } = await reasoningParent();
    const host = await bootExtension({ "thk/one": ONE_STEP }, { worker: agentMd("worker", "rtprov/m1") });
    await host.fire("session_start", parent.ctx);

    const result = await runFlowViaEvent(host, "thk:one");

    expect(result.status, why(result)).toBe("success");
    expect(received[0]?.reasoning).toBe("medium");
  }, 20_000);
});

describe("agent step: the ref's thinking level reaches the model", () => {
  it("role `@fast` resolved to `:minimal` -> model receives minimal (not the default)", async () => {
    const { parent, received } = await reasoningParent();
    const host = await bootExtension({ "thk/one": ONE_STEP }, { worker: agentMd("worker", "\"@fast\"") });
    host.pi.events.on("model:resolve", roleHandler(parent, "minimal"));
    await host.fire("session_start", parent.ctx);

    const result = await runFlowViaEvent(host, "thk:one");

    expect(result.status, why(result)).toBe("success");
    expect(sessionCalls[0]?.thinkingLevel).toBe("minimal");
    expect(received[0]?.reasoning).toBe("minimal");
  }, 20_000);

  it("role `@fast` resolved to `:high` -> model receives high", async () => {
    const { parent, received } = await reasoningParent();
    const host = await bootExtension({ "thk/one": ONE_STEP }, { worker: agentMd("worker", "\"@fast\"") });
    host.pi.events.on("model:resolve", roleHandler(parent, "high"));
    await host.fire("session_start", parent.ctx);

    await runFlowViaEvent(host, "thk:one");

    expect(sessionCalls[0]?.thinkingLevel).toBe("high");
    expect(received[0]?.reasoning).toBe("high");
  }, 20_000);

  it("literal suffix `rtprov/m1:high` (no handler) -> model receives high", async () => {
    const { parent, received } = await reasoningParent();
    const host = await bootExtension({ "thk/one": ONE_STEP }, { worker: agentMd("worker", "rtprov/m1:high") });
    await host.fire("session_start", parent.ctx);

    const result = await runFlowViaEvent(host, "thk:one");

    expect(result.status, why(result)).toBe("success");
    expect(sessionCalls[0]?.thinkingLevel).toBe("high");
    expect(received[0]?.reasoning).toBe("high");
  }, 20_000);

  it("`:off` from the role is honoured (model receives no reasoning), not the default", async () => {
    const { parent, received } = await reasoningParent();
    const host = await bootExtension({ "thk/one": ONE_STEP }, { worker: agentMd("worker", "\"@fast\"") });
    host.pi.events.on("model:resolve", roleHandler(parent, "off"));
    await host.fire("session_start", parent.ctx);

    await runFlowViaEvent(host, "thk:one");

    expect(sessionCalls[0]?.thinkingLevel).toBe("off");
    expect(received[0]?.reasoning).toBeUndefined();
  }, 20_000);

  it("agent `thinking:` frontmatter still wins over the role's level", async () => {
    const { parent, received } = await reasoningParent();
    const host = await bootExtension({ "thk/one": ONE_STEP }, { worker: agentMd("worker", "\"@fast\"", "low") });
    host.pi.events.on("model:resolve", roleHandler(parent, "minimal"));
    await host.fire("session_start", parent.ctx);

    await runFlowViaEvent(host, "thk:one");

    expect(sessionCalls[0]?.thinkingLevel).toBe("low");
    expect(received[0]?.reasoning).toBe("low");
  }, 20_000);
});

describe("decision agents keep the ref's level (regression guard)", () => {
  it("agent-decision with `@fast` -> `:high` -> model receives high", async () => {
    const { parent, received } = await reasoningParent();
    const flow = [
      "name: dec",
      "description: d",
      "steps:",
      "  - id: decide",
      "    type: agent-decision",
      "    agent: worker",
      "    task: DECIDE now",
      "    branches:",
      "      done: after",
      "  - id: after",
      "    type: agent",
      "    agent: worker",
      "    task: AFTER work",
      "",
    ].join("\n");
    const host = await bootExtension({ "thk/dec": flow }, { worker: agentMd("worker", "\"@fast\"") });
    host.pi.events.on("model:resolve", roleHandler(parent, "high"));
    await host.fire("session_start", parent.ctx);

    const result = await runFlowViaEvent(host, "thk:dec");

    expect(result.status, why(result)).toBe("success");
    expect(received.find((r) => /DECIDE/.test(r.task))?.reasoning).toBe("high");
    expect(received.find((r) => /AFTER/.test(r.task))?.reasoning).toBe("high");
  }, 20_000);
});
