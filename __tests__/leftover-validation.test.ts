/**
 * Leftovers from the fix-all pass: `tools: []` is a valid "no tools" agent,
 * and `on_error` targets on every step type must exist.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";

const agent = (tools: string) => `---\nname: a\ndescription: d\ntools: ${tools}\n---\n\nbody\n`;

describe("tools: [] means no tools", () => {
  it("is valid for an authored agent", () => {
    const r = validateAgentContent(agent("[]"));
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("the shipped flow-decision agent validates", () => {
    const r = validateAgentContent(readFileSync("agents/flow-decision.md", "utf8"));
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("on_error targets must exist", () => {
  const flow = (step: string) => `name: f\ndescription: d\nsteps:\n${step}\n  - id: report\n    type: code\n`;
  for (const [kind, step] of [
    ["agent", "  - id: s\n    type: agent\n    agent: a\n    task: t\n    on_error: nope"],
    ["agent-decision", "  - id: s\n    type: agent-decision\n    agent: a\n    task: t\n    branches:\n      x: report\n    on_error: nope"],
    ["fork", "  - id: s\n    type: fork\n    question: q\n    options: [x]\n    branches:\n      x: report\n    on_error: nope"],
  ] as const) {
    it(`${kind}: unknown on_error target is an error`, () => {
      const r = validateFlowContent(flow(step));
      const e = r.diagnostics.filter((d) => d.severity === "error" && /on_error/.test(d.message) && /nope/.test(d.message));
      expect(e.length, JSON.stringify(r.diagnostics)).toBe(1);
    });
  }
});
