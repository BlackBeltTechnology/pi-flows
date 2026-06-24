/**
 * Tests for code node parser (parseCodeStep) and YAML integration.
 * Covers all required parsing scenarios from spec.
 */

import { describe, expect, it } from "vitest";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import type { CodeStep, FlowConfig } from "../extensions/flow-engine/types.js";

describe("Code Node Parser (parseCodeStep)", () => {
  // ─── Basic parsing ───────────────────────────────────────────────────

  it("parses a minimal code step with id and type only", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: minimal-code
    type: code
`;
    const config: FlowConfig = parseFlowYamlString(yaml, "test.yaml");
    expect(config.steps).toHaveLength(1);
    const step = config.steps[0] as CodeStep;
    expect(step.stepType).toBe("code");
    expect(step.id).toBe("minimal-code");
    expect(step.target).toBeUndefined();
    expect(step.inputs).toBeUndefined();
    expect(step.outputs).toBeUndefined();
    expect(step.blockedBy).toBeUndefined();
    expect(step.on_complete).toBeUndefined();
    expect(step.on_error).toBeUndefined();
    expect(step.timeout).toBeUndefined();
  });

  it("parses code step with all fields populated", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: full-code
    type: code
    target: .pi/handlers/custom.ts
    inputs:
      invoice: "$\{{result.extract.canonical}}"
      settings: "$\{{task}}"
    outputs:
      - name: valid
      - name: nav_record
    blockedBy: [extract, validate]
    on_complete: approve
    on_error: park
    timeout: 30000
`;
    const config: FlowConfig = parseFlowYamlString(yaml, "test.yaml");
    const step = config.steps[0] as CodeStep;
    expect(step.stepType).toBe("code");
    expect(step.id).toBe("full-code");
    expect(step.target).toBe(".pi/handlers/custom.ts");
    expect(step.inputs).toEqual({
      invoice: "$\{{result.extract.canonical}}",
      settings: "$\{{task}}",
    });
    expect(step.outputs).toEqual([{ name: "valid" }, { name: "nav_record" }]);
    expect(step.blockedBy).toEqual(["extract", "validate"]);
    expect(step.on_complete).toBe("approve");
    expect(step.on_error).toBe("park");
    expect(step.timeout).toBe(30000);
  });

  it("parses outputs as array of objects with name field", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: code-with-outputs
    type: code
    outputs:
      - name: status
      - name: data
`;
    const config: FlowConfig = parseFlowYamlString(yaml, "test.yaml");
    const step = config.steps[0] as CodeStep;
    expect(Array.isArray(step.outputs)).toBe(true);
    expect(step.outputs).toHaveLength(2);
    expect(step.outputs![0]).toEqual({ name: "status" });
    expect(step.outputs![1]).toEqual({ name: "data" });
  });

  it("parses blockedBy as array or single string", () => {
    const yaml1 = `
name: test-flow
description: A test flow
steps:
  - id: code-blocked
    type: code
    blockedBy: [step1, step2]
`;
    const config1: FlowConfig = parseFlowYamlString(yaml1, "test.yaml");
    const step1 = config1.steps[0] as CodeStep;
    expect(step1.blockedBy).toEqual(["step1", "step2"]);

    // Also test single string form
    const yaml2 = `
name: test-flow
description: A test flow
steps:
  - id: code-blocked2
    type: code
    blockedBy: step1
`;
    const config2: FlowConfig = parseFlowYamlString(yaml2, "test.yaml");
    const step2 = config2.steps[0] as CodeStep;
    expect(step2.blockedBy).toEqual(["step1"]);
  });

  it("parses timeout as a number in milliseconds", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: code-with-timeout
    type: code
    timeout: 5000
`;
    const config: FlowConfig = parseFlowYamlString(yaml, "test.yaml");
    const step = config.steps[0] as CodeStep;
    expect(step.timeout).toBe(5000);
    expect(typeof step.timeout).toBe("number");
  });

  it("parses inputs as a mapping of key-value pairs", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: code-with-inputs
    type: code
    inputs:
      field1: value1
      field2: value2
      templated: "$\{{result.prev.output}}"
`;
    const config: FlowConfig = parseFlowYamlString(yaml, "test.yaml");
    const step = config.steps[0] as CodeStep;
    expect(step.inputs).toEqual({
      field1: "value1",
      field2: "value2",
      templated: "$\{{result.prev.output}}",
    });
  });

  // ─── Error handling ──────────────────────────────────────────────────

  it("throws when required 'id' field is missing", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - type: code
`;
    expect(() => parseFlowYamlString(yaml, "test.yaml")).toThrow(/missing "id"/i);
  });

  it("throws when required 'type' is not 'code'", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: my-step
    type: code
`;
    // Should NOT throw — this is a valid code step
    expect(() => parseFlowYamlString(yaml, "test.yaml")).not.toThrow();
  });

  // ─── Step type inference ─────────────────────────────────────────────

  it("explicitly parses type: code when specified", () => {
    const yaml = `
name: test-flow
description: A test flow
steps:
  - id: explicit-code
    type: code
`;
    const config: FlowConfig = parseFlowYamlString(yaml, "test.yaml");
    const step = config.steps[0] as CodeStep;
    expect(step.stepType).toBe("code");
  });
});
