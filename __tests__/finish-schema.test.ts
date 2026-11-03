/**
 * Tests for the finish-tool TypeBox schema built by `createGuardExtension`
 * (spec `agent-node`, change: enhance-agent-node-contract).
 *
 * Declared outputs are REQUIRED and encode `type`/`pattern` as string
 * constraints. An invalid regex degrades to a plain string.
 */

import { describe, expect, it } from "vitest";
import type { AgentOutput } from "../extensions/flow-engine/types.js";
import { createGuardExtension } from "../extensions/flow-engine/guard.js";

const NUMERIC_PATTERN = "^-?\\d+(\\.\\d+)?$";
const BOOLEAN_PATTERN = "^(true|false)$";

/** Run the guard factory with a stub pi and capture the finish tool schema. */
function buildFinishSchema(agentOutputs?: AgentOutput[]): any {
  let captured: any;
  const pi: any = {
    on: () => {},
    registerTool: (def: any) => {
      if (def.name === "finish") captured = def.parameters;
    },
  };
  createGuardExtension({ requireFinish: true, agentOutputs })(pi);
  return captured;
}

describe("finish schema — base params", () => {
  it("status and summary are required; files and artifacts are not in the schema", () => {
    const schema = buildFinishSchema();
    expect(schema.required).toEqual(expect.arrayContaining(["status", "summary"]));
    expect(schema.properties).not.toHaveProperty("files");
    expect(schema.properties).not.toHaveProperty("artifacts");
  });
});

describe("finish schema — declared outputs", () => {
  it("declared outputs are optional in the schema (required only on status complete, enforced by the guard)", () => {
    const schema = buildFinishSchema([{ name: "verdict" }]);
    expect(schema.required ?? []).not.toContain("verdict");
    expect(schema.properties.verdict.type).toBe("string");
  });

  it("explicit pattern surfaces on the property", () => {
    const schema = buildFinishSchema([{ name: "file_path", pattern: "^/.+" }]);
    expect(schema.properties.file_path.pattern).toBe("^/.+");
  });

  it("type: number → a number or a numeric-pattern string", () => {
    const schema = buildFinishSchema([{ name: "count", type: "number" }]);
    expect(schema.properties.count.anyOf).toEqual([
      expect.objectContaining({ type: "number" }),
      expect.objectContaining({ type: "string", pattern: NUMERIC_PATTERN }),
    ]);
  });

  it("type: boolean → a boolean or a true|false string", () => {
    const schema = buildFinishSchema([{ name: "ok", type: "boolean" }]);
    expect(schema.properties.ok.anyOf).toEqual([
      expect.objectContaining({ type: "boolean" }),
      expect.objectContaining({ type: "string", pattern: BOOLEAN_PATTERN }),
    ]);
  });

  it("explicit pattern wins over type", () => {
    const schema = buildFinishSchema([{ name: "x", type: "number", pattern: "^/.+" }]);
    expect(schema.properties.x.pattern).toBe("^/.+");
  });

  it("invalid regex degrades to a plain string (no pattern, no throw)", () => {
    const schema = buildFinishSchema([{ name: "bad", pattern: "([unclosed" }]);
    expect(schema.properties.bad.type).toBe("string");
    expect(schema.properties.bad.pattern).toBeUndefined();
  });

  it("description falls back to a default when omitted", () => {
    const schema = buildFinishSchema([{ name: "thing" }]);
    expect(schema.properties.thing.description).toBe("Output: thing");
  });
});
