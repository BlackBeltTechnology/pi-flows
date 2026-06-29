/**
 * Typed flow input (change: flow-typed-io-and-run-state, G6).
 * FlowConfig `inputs:` schema, structured run-start input, `${{flow.input.*}}`
 * resolution + typed delivery to code nodes, and required-input validation.
 */

import { describe, it, expect } from "vitest";
import { runFaux, runFauxFlow, makeAgent, scriptFinish } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import type { FlowConfig } from "../extensions/flow-engine/types.js";

describe("typed flow input — schema parsing", () => {
  it("parses an inputs: schema", () => {
    const yaml = [
      "name: f", "description: d",
      "inputs:",
      "  ref: { type: string, required: true }",
      "  count: { type: number }",
      "steps:",
      "  - id: a",
      "    type: agent",
      "    agent: x",
    ].join("\n");
    const flow = parseFlowYamlString(yaml, "<t>");
    expect(flow.inputs).toEqual({ ref: { type: "string", required: true }, count: { type: "number" } });
  });

  it("rejects an input with an invalid type", () => {
    const yaml = ["name: f", "description: d", "inputs:", "  bad: { type: blob }", "steps:", "  - id: a", "    type: agent", "    agent: x"].join("\n");
    expect(() => parseFlowYamlString(yaml, "<t>")).toThrow(/valid "type"/);
  });
});

describe("typed flow input — runtime", () => {
  it("exposes ${{flow.input.NAME}} in an agent task", async () => {
    const flow: FlowConfig = {
      name: "fi", description: "d", source: "<faux>",
      inputs: { ref: { type: "string", required: true } },
      steps: [{ stepType: "agent", id: "a", agent: "a", task: "handle ${{flow.input.ref}}" }],
    };
    const result = await runFaux({
      flow,
      agents: [makeAgent({ name: "a", model: "faux/faux-1" })],
      flowInput: { ref: "ABC" },
      responder: (t) => scriptFinish({ status: "complete", summary: `got: ${t}` }),
    });
    expect(result.results.a.summary).toContain("handle ABC");
  });

  it("delivers a typed flow input to a code node (whole-value reference)", async () => {
    const flow: FlowConfig = {
      name: "fic", description: "d", source: "<faux>",
      inputs: { n: { type: "number", required: true } },
      steps: [{ stepType: "code", id: "c", outputs: [{ name: "doubled" }], inputs: { n: "${{flow.input.n}}" } }],
    };
    const result = await runFauxFlow({
      flow,
      agents: [],
      codeHandlers: { c: "export default async (input) => ({ doubled: input.n * 2 });" },
      responder: () => scriptFinish({ status: "complete", summary: "" }),
      flowInput: { n: 21 },
    });
    expect(result.results.c.outputs.doubled).toBe(42);
  });

  it("fails the run when a required input is missing", async () => {
    const flow: FlowConfig = {
      name: "fim", description: "d", source: "<faux>",
      inputs: { ref: { type: "string", required: true } },
      steps: [{ stepType: "agent", id: "a", agent: "a", task: "x" }],
    };
    const result = await runFaux({
      flow,
      agents: [makeAgent({ name: "a", model: "faux/faux-1" })],
      responder: () => scriptFinish({ status: "complete", summary: "" }),
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.output).toContain("missing required input");
  });
});
