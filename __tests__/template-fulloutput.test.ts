/** ${{result.<id>.fullOutput}} and bare ${{result.<id>}} give the agent's reply text in task templates. */
import { describe, expect, it } from "vitest";
import { expandTemplateVariables } from "../extensions/flow-engine/execution.js";

const ctx = (outputs: Record<string, unknown> = {}) => ({
  task: "t", inputs: {},
  results: { w: { fullOutput: "the haiku\nline two", status: "complete", summary: "Wrote a haiku", outputs } },
}) as any;

describe("fullOutput in task templates", () => {
  it(".fullOutput expands to the reply text", () => {
    expect(expandTemplateVariables("X ${{result.w.fullOutput}}", ctx())).toBe("X the haiku\nline two");
  });
  it("bare reference expands to the reply text", () => {
    expect(expandTemplateVariables("${{result.w}}", ctx())).toBe("the haiku\nline two");
  });
  it(".summary stays the finish summary", () => {
    expect(expandTemplateVariables("${{result.w.summary}}", ctx())).toBe("Wrote a haiku");
  });
  it("a declared output named fullOutput wins", () => {
    expect(expandTemplateVariables("${{result.w.fullOutput}}", ctx({ fullOutput: "declared" }))).toBe("declared");
  });
});
