// Finish-output retry contract (harden-flow-wiring §6.1).
//
// When an agent declares outputs, a finish(status:"complete") missing any of
// them is blocked by the guard's tool_call hook (guard.ts; the schema keeps them
// optional so error/blocked finishes need none). The rejection drives the bounded followUp retry inside spawnAgent (capped at
// MAX_FINISH_RETRIES). When the agent never produces a schema-valid finish,
// the run resolves as a SOFT failure (never "unknown", never "hard" absent an
// API error) via classifyAgentOutcome.
//
// The in-session followUp loop itself needs a live session; here we lock the
// two unit-testable ends of that contract: (1) the schema rejection that
// TRIGGERS a retry, and (2) the classification at retry EXHAUSTION.

import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { AgentOutput } from "../extensions/flow-engine/types.js";
import { createGuardExtension } from "../extensions/flow-engine/guard.js";
import { classifyAgentOutcome } from "../extensions/flow-engine/failure.js";

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

describe("finish-output retry — schema rejection drives the retry (§6.1)", () => {
  const schema = buildFinishSchema([{ name: "verdict" }]);

  it("a complete finish missing a required declared output is rejected (→ followUp retry)", () => {
    // This invalid finish is exactly what the in-session retry responds to.
    expect(finishBlocked([{ name: "verdict" }], { ...base })).toBe(true);
  });

  it("an error/blocked finish without the declared output is accepted", () => {
    for (const status of ["error", "blocked"]) {
      expect(Value.Check(schema, { ...base, status })).toBe(true);
      expect(finishBlocked([{ name: "verdict" }], { ...base, status })).toBe(false);
    }
  });

  it("the same finish passes once the required output is supplied (retry would succeed)", () => {
    expect(Value.Check(schema, { ...base, verdict: "pass" })).toBe(true);
  });
});

describe("finish-output retry — exhaustion resolves SOFT (§6.1)", () => {
  it("an agent that never produces a valid finish (no finishParams) is SOFT, not unknown/hard", () => {
    const { outcome } = classifyAgentOutcome(undefined, undefined);
    expect(outcome).toBe("soft");
  });

  it("exhaustion without a terminal API error never escalates to hard", () => {
    const { outcome, failureInfo } = classifyAgentOutcome(undefined, undefined);
    expect(outcome).not.toBe("hard");
    expect(failureInfo?.source).toBe("agent_no_finish");
  });
});
