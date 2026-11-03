/**
 * Tests that the tightened finish schema actually REJECTS non-conforming
 * finish params (spec `agent-node`, change: enhance-agent-node-contract).
 *
 * The SDK validates finish args against this schema; a failed check is what
 * drives the existing followUp retry in spawnAgent. We assert the contract
 * directly via TypeBox's Value.Check. Required presence is enforced only on
 * status "complete", by the guard's tool_call hook (not the schema).
 */

import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { AgentOutput } from "../extensions/flow-engine/types.js";
import { createGuardExtension } from "../extensions/flow-engine/guard.js";

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

const base = { status: "complete", summary: "done", files: [] as unknown[] };

/** Run a finish call through a fresh guard's tool_call hooks; true when blocked. */
function finishBlocked(agentOutputs: AgentOutput[], input: Record<string, unknown>): boolean {
  const hooks: Array<(e: any) => any> = [];
  const pi: any = { on: (ev: string, h: any) => { if (ev === "tool_call") hooks.push(h); }, registerTool: () => {} };
  createGuardExtension({ requireFinish: true, agentOutputs })(pi);
  return hooks.some((h) => h({ toolName: "finish", input })?.block === true);
}

describe("output validation — required presence", () => {
  const schema = buildFinishSchema([{ name: "verdict" }]);

  it("passes when the declared output is present", () => {
    expect(Value.Check(schema, { ...base, verdict: "pass" })).toBe(true);
  });

  it("fails when the declared output is missing on a complete finish", () => {
    expect(finishBlocked([{ name: "verdict" }], { ...base })).toBe(true);
  });

  it("passes without the declared output on an error/blocked finish", () => {
    expect(Value.Check(schema, { ...base, status: "error" })).toBe(true);
    expect(finishBlocked([{ name: "verdict" }], { ...base, status: "blocked" })).toBe(false);
  });
});

describe("output validation — pattern", () => {
  const schema = buildFinishSchema([{ name: "file_path", pattern: "^/.+" }]);

  it("passes a matching value", () => {
    expect(Value.Check(schema, { ...base, file_path: "/abs/path.ts" })).toBe(true);
  });

  it("fails a non-matching value", () => {
    expect(Value.Check(schema, { ...base, file_path: "relative.ts" })).toBe(false);
  });
});

describe("output validation — type-derived patterns", () => {
  const schema = buildFinishSchema([
    { name: "count", type: "number" },
    { name: "ok", type: "boolean" },
  ]);

  it("passes numeric and boolean strings", () => {
    expect(Value.Check(schema, { ...base, count: "42", ok: "true" })).toBe(true);
    expect(Value.Check(schema, { ...base, count: "-3.14", ok: "false" })).toBe(true);
  });

  it("fails a non-numeric count", () => {
    expect(Value.Check(schema, { ...base, count: "abc", ok: "true" })).toBe(false);
  });

  it("fails a non-boolean ok", () => {
    expect(Value.Check(schema, { ...base, count: "1", ok: "yes" })).toBe(false);
  });
});

describe("output validation — extra fields", () => {
  const schema = buildFinishSchema([{ name: "verdict" }]);

  it("ignores undeclared extra fields", () => {
    expect(Value.Check(schema, { ...base, verdict: "pass", extra: "whatever" })).toBe(true);
  });
});
