/**
 * Fresh definitions per run: edits to agent/flow files on disk apply to the
 * NEXT flow run in the same session, without /reload (flow:rediscover).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { scriptFinish, lastUserText } from "./faux-harness.js";
import { activate } from "../extensions/flow-engine/index.js";
import { makeParentSession, fakeExtensionHost, writeFlowFixture, runFlowViaEvent, agentMd } from "./helpers/parent-session.js";

const flowYaml = (task: string) =>
  `name: one\ndescription: d\nsteps:\n  - id: s\n    type: agent\n    agent: worker\n    task: ${task}\n`;

async function setup(commands?: Map<string, any>) {
  const parent = await makeParentSession();
  const seen: { system: string; user: string }[] = [];
  parent.faux.setResponses(Array.from({ length: 24 }, () => (ctx: any) => {
    seen.push({ system: getCurrentSystemPrompt(ctx?.messages ?? []), user: lastUserText(ctx) });
    return scriptFinish({ status: "complete", summary: "ok" });
  }));
  const host = fakeExtensionHost();
  if (commands) host.pi.registerCommand = (name: string, def: any) => { commands.set(name, def); };
  activate(host.pi);
  const dirs = writeFlowFixture(
    { "fr/one": flowYaml("first-task") },
    { worker: agentMd("worker", "rtprov/m1").replace("You are a test agent.", "BODY-ONE") },
  );
  await host.emit("flow:register-agents-dir", { dir: dirs.agentsDir });
  await host.emit("flow:register-flows-dir", { dir: dirs.flowsDir });
  await host.fire("session_start", parent.ctx);
  return { host, seen, ...dirs };
}

describe("fresh definitions per run", () => {
  it("flow:run picks up an edited agent file and flow file without a reload", async () => {
    const { host, seen, agentsDir, flowsDir } = await setup();
    expect((await runFlowViaEvent(host, "fr:one")).status).toBe("success");
    expect(seen[0].system).toContain("BODY-ONE");
    expect(seen[0].user).toContain("first-task");

    writeFileSync(join(agentsDir, "worker.md"), agentMd("worker", "rtprov/m1").replace("You are a test agent.", "BODY-TWO"));
    writeFileSync(join(flowsDir, "fr/one", "flow.yaml"), flowYaml("second-task"));

    expect((await runFlowViaEvent(host, "fr:one")).status).toBe("success");
    const second = seen[seen.length - 1];
    expect(second.system).toContain("BODY-TWO");
    expect(second.user).toContain("second-task");
  }, 30_000);

  it("the slash-command path also picks up edits without a reload", async () => {
    const commands = new Map<string, any>();
    const { host, seen, agentsDir, flowsDir } = await setup(commands);
    const runViaCommand = async () => {
      const done = host.next("flow:complete");
      await commands.get("fr:one").handler("go", {});
      return done;
    };
    expect((await runViaCommand()).status).toBe("success");
    expect(seen[0].system).toContain("BODY-ONE");

    writeFileSync(join(agentsDir, "worker.md"), agentMd("worker", "rtprov/m1").replace("You are a test agent.", "BODY-TWO"));
    writeFileSync(join(flowsDir, "fr/one", "flow.yaml"), flowYaml("second-task"));

    expect((await runViaCommand()).status).toBe("success");
    const second = seen[seen.length - 1];
    expect(second.system).toContain("BODY-TWO");
    expect(second.user).toContain("second-task");
  }, 30_000);
});
