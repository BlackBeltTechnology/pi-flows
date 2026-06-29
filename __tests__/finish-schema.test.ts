/**
 * Tests for the finish-tool TypeBox schema built by `createGuardExtension`
 * (spec `agent-node`, change: enhance-agent-node-contract).
 *
 * Declared outputs are REQUIRED and encode `type`/`pattern` as string
 * constraints. An invalid regex degrades to a plain required string.
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
  it("declared outputs are required (not optional)", () => {
    const schema = buildFinishSchema([{ name: "verdict" }]);
    expect(schema.required).toContain("verdict");
    expect(schema.properties.verdict.type).toBe("string");
  });

  it("explicit pattern surfaces on the property", () => {
    const schema = buildFinishSchema([{ name: "file_path", pattern: "^/.+" }]);
    expect(schema.properties.file_path.pattern).toBe("^/.+");
  });

  it("type: number → numeric string pattern", () => {
    const schema = buildFinishSchema([{ name: "count", type: "number" }]);
    expect(schema.properties.count.pattern).toBe(NUMERIC_PATTERN);
  });

  it("type: boolean → true|false pattern", () => {
    const schema = buildFinishSchema([{ name: "ok", type: "boolean" }]);
    expect(schema.properties.ok.pattern).toBe(BOOLEAN_PATTERN);
  });

  it("explicit pattern wins over type", () => {
    const schema = buildFinishSchema([{ name: "x", type: "number", pattern: "^/.+" }]);
    expect(schema.properties.x.pattern).toBe("^/.+");
  });

  it("invalid regex degrades to a plain required string (no pattern, no throw)", () => {
    const schema = buildFinishSchema([{ name: "bad", pattern: "([unclosed" }]);
    expect(schema.properties.bad.type).toBe("string");
    expect(schema.properties.bad.pattern).toBeUndefined();
    expect(schema.required).toContain("bad");
  });

  it("description falls back to a default when omitted", () => {
    const schema = buildFinishSchema([{ name: "thing" }]);
    expect(schema.properties.thing.description).toBe("Output: thing");
  });
});
