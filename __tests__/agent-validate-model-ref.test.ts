import { describe, expect, it } from "vitest";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";

function md(modelLines: string): string {
  return `---\nname: a\ndescription: d\n${modelLines}tools: read\n---\n\nbody\n`;
}
const modelDiags = (c: string) =>
  validateAgentContent(c).diagnostics.filter((d) => /model|thinking/i.test(d.message));

describe("agent validation — model refs are opaque", () => {
  it("any @-ref passes without diagnostics", () => {
    expect(modelDiags(md("model: @my-custom-alias\n"))).toEqual([]);
  });

  it("list and omitted model produce no error", () => {
    for (const c of [md("model: [@fast, anthropic/claude-haiku-4-5]\n"), md("")]) {
      const r = validateAgentContent(c);
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(r.valid).toBe(true);
    }
  });

  it("block list validates", () => {
    const r = validateAgentContent(md("model:\n  - @fast\n  - anthropic/claude-haiku-4-5:high\n"));
    expect(r.valid).toBe(true);
    expect(modelDiags(md("model:\n  - @fast\n  - anthropic/claude-haiku-4-5:high\n"))).toEqual([]);
  });

  it("invalid thinking suffix names level and valid levels", () => {
    const d = modelDiags(md("model: anthropic/claude-haiku-4-5:extreme\n"));
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].message).toContain("extreme");
    const all = d.map((x) => x.message + (x.suggestion ?? "")).join(" ");
    expect(all).toContain("minimal");
    expect(all).toContain("xhigh");
  });
});
