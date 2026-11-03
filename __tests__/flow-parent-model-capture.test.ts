/** 4.3 — session model captured at flow start; legacy @ref falls back on it. */
import { describe, it, expect } from "vitest";
import { scriptFinish } from "./faux-harness.js";
import { makeParentSession, bootExtension, runFlowViaEvent, agentMd } from "./helpers/parent-session.js";

describe("parent model snapshot", () => {
  it("@fast agent with no resolver runs on the session_start model", async () => {
    const parent = await makeParentSession("capprov", [{ id: "m1" }]);
    parent.faux.setResponses(Array.from({ length: 6 }, () => scriptFinish({ status: "complete", summary: "ok" })));
    const host = await bootExtension(
      { "t/cap": "name: cap\ndescription: d\nsteps:\n  - id: a\n    type: agent\n    agent: w\n    task: go\n" },
      { w: agentMd("w", "@fast") },
    );
    await host.fire("session_start", { ...parent.ctx, model: parent.registry.find("capprov", "m1") });
    const payload = await runFlowViaEvent(host, "t:cap");
    expect(payload.status ?? payload.result?.status).toBeDefined();
    expect(JSON.stringify(payload)).not.toMatch(/Cannot resolve role/);
    expect(JSON.stringify(payload)).toMatch(/complete/);
  });
});
