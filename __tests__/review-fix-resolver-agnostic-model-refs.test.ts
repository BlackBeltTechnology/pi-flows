/**
 * Review-fix tests for change `resolver-agnostic-model-refs`.
 */
import { describe, expect, it } from "vitest";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";

const md = (modelLines: string) => `---\nname: a\ndescription: d\n${modelLines}tools: read\n---\n\nbody\n`;
const errors = (c: string) => validateAgentContent(c).diagnostics.filter((d) => d.severity === "error");

describe("R1 — ':suffix' that is not a thinking level", () => {
  it("literal ids with a colon (ollama/llama3:8b, openrouter/x:free) are not errors", () => {
    for (const m of ["ollama/llama3:8b", "openrouter/x:free"]) {
      const r = validateAgentContent(md(`model: ${m}\n`));
      expect(errors(md(`model: ${m}\n`)), m).toEqual([]);
      expect(r.valid, m).toBe(true);
    }
  });

  it("an @role with a bad thinking suffix is an error", () => {
    const e = errors(md("model: @fast:bogus\n"));
    expect(e.length).toBe(1);
    expect(e[0].message).toContain("bogus");
    expect(validateAgentContent(md("model: @fast:bogus\n")).valid).toBe(false);
    expect(errors(md("model: @fast:high\n"))).toEqual([]);
  });

  it("spec scenario: literal :extreme still yields a diagnostic naming the level and valid levels", () => {
    const d = validateAgentContent(md("model: anthropic/claude-haiku-4-5:extreme\n")).diagnostics;
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].message).toContain("extreme");
    expect(d.map((x) => x.message + (x.suggestion ?? "")).join(" ")).toContain("xhigh");
  });
});
