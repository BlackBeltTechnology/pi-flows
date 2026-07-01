/**
 * Tests for code node validation rules.
 * Covers all required validation scenarios from spec.
 */

import { describe, expect, it } from "vitest";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import type { CodeStep, FlowConfig, Diagnostic } from "../extensions/flow-engine/types.js";

describe("Code Node Validation", () => {
  // ─── Valid code nodes (should pass validation) ─────────────────────

  it("accepts a valid code step with all fields", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: validate-nav
    type: code
    inputs:
      invoice: "$\{{result.extract.canonical}}"
    outputs:
      - name: valid
      - name: nav_record
    blockedBy: [extract]
    on_error: park
  - id: extract
    type: agent
    agent: my-agent
  - id: approve
    type: agent
    agent: approve-agent
  - id: park
    type: agent
    agent: park-agent
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  it("accepts a code step with no inputs or outputs", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: side-effect-code
    type: code
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  // ─── ID validation (filesystem-safe) ──────────────────────────────

  it("accepts id with valid characters: alphanumeric, dash, underscore, dot", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: valid_id.step-123
    type: code
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  it("rejects id with slash (filesystem-unsafe)", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: invalid/id
    type: code
`;
    const result = validateFlowContent(yaml);
    const idErrors = result.diagnostics.filter(d => d.message.includes("id") && d.message.includes("filesystem"));
    expect(idErrors.length).toBeGreaterThan(0);
  });

  it("rejects id with backslash (filesystem-unsafe)", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: invalid\\id
    type: code
`;
    const result = validateFlowContent(yaml);
    const idErrors = result.diagnostics.filter(d => d.message.includes("id") && d.message.includes("filesystem"));
    expect(idErrors.length).toBeGreaterThan(0);
  });

  it("rejects id with double-dot (path traversal risk)", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: ../evil
    type: code
`;
    const result = validateFlowContent(yaml);
    const idErrors = result.diagnostics.filter(d => d.message.includes("id"));
    expect(idErrors.length).toBeGreaterThan(0);
  });

  // ─── Output name validation (valid JS identifiers) ──────────────────

  it("accepts output names that are valid JS identifiers", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    outputs:
      - name: valid_output
      - name: _private
      - name: $special
      - name: output123
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  it("rejects output name starting with a digit", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    outputs:
      - name: 123invalid
`;
    const result = validateFlowContent(yaml);
    const outputErrors = result.diagnostics.filter(d => d.message.includes("output") && d.message.includes("identifier"));
    expect(outputErrors.length).toBeGreaterThan(0);
  });

  it("rejects output name with special characters (except _ and $)", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    outputs:
      - name: invalid-name
`;
    const result = validateFlowContent(yaml);
    const outputErrors = result.diagnostics.filter(d => d.message.includes("output") && d.message.includes("identifier"));
    expect(outputErrors.length).toBeGreaterThan(0);
  });

  it("rejects duplicate output names", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    outputs:
      - name: status
      - name: status
`;
    const result = validateFlowContent(yaml);
    const dupErrors = result.diagnostics.filter(d => d.message.includes("output") && (d.message.includes("duplicate") || d.message.includes("unique")));
    expect(dupErrors.length).toBeGreaterThan(0);
  });

  // ─── Input name validation (valid JS identifiers) ───────────────────

  it("accepts input names that are valid JS identifiers", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    inputs:
      valid_input: value1
      _private: value2
      $special: value3
      input123: value4
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  it("rejects input name starting with a digit", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    inputs:
      123invalid: value
`;
    const result = validateFlowContent(yaml);
    const inputErrors = result.diagnostics.filter(d => d.message.includes("input") && d.message.includes("identifier"));
    expect(inputErrors.length).toBeGreaterThan(0);
  });

  it("rejects input name with invalid characters", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    inputs:
      invalid-input: value
`;
    const result = validateFlowContent(yaml);
    const inputErrors = result.diagnostics.filter(d => d.message.includes("input") && d.message.includes("identifier"));
    expect(inputErrors.length).toBeGreaterThan(0);
  });

  // ─── blockedBy reference validation ──────────────────────────────────

  it("accepts blockedBy references to existing steps", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: step1
    type: agent
    agent: my-agent
  - id: step2
    type: code
    blockedBy: [step1]
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  it("rejects blockedBy reference to non-existent step", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    blockedBy: [nonexistent]
`;
    const result = validateFlowContent(yaml);
    const refErrors = result.diagnostics.filter(d => d.message.includes("blockedBy") && d.message.includes("unknown"));
    expect(refErrors.length).toBeGreaterThan(0);
  });

  // ─── on_error reference validation; on_complete removal ─────────────

  it("accepts on_error references to existing steps", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    on_error: error-handler
  - id: error-handler
    type: agent
    agent: handler-agent
`;
    const result = validateFlowContent(yaml);
    const codeErrors = result.diagnostics.filter(d => d.severity === "error");
    expect(codeErrors).toHaveLength(0);
  });

  it("rejects on_error reference to non-existent step", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    on_error: nonexistent
`;
    const result = validateFlowContent(yaml);
    const refErrors = result.diagnostics.filter(d => d.message.includes("on_error") && d.message.includes("unknown"));
    expect(refErrors.length).toBeGreaterThan(0);
  });

  it("rejects any step declaring on_complete (removed field)", () => {
    const yaml = `name: test-flow
description: Test flow
steps:
  - id: code-step
    type: code
    on_complete: next-step
  - id: next-step
    type: code
`;
    const result = validateFlowContent(yaml);
    const removed = result.diagnostics.filter(d => d.message.includes("on_complete") && /remov/i.test(d.message));
    expect(removed.length).toBeGreaterThan(0);
  });
});
