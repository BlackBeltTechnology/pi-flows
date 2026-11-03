/** Sub-flows were removed: `type: flow-ref` is an unknown step type (change: remove-flow-ref-from-specs). */
import { describe, expect, it } from "vitest";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";

describe("flow-ref is not a step type", () => {
  it("parser rejects type: flow-ref naming the type and the step", () => {
    const yaml = "name: f\ndescription: d\nsteps:\n  - id: sub\n    type: flow-ref\n    flow: other\n";
    expect(() => parseFlowYamlString(yaml, "<t>")).toThrow(/flow-ref[\s\S]*sub|sub[\s\S]*flow-ref/);
  });
});
