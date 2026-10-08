/**
 * spawnAgent on anthropic-messages uses plain pi tool names (no mcp__flows__).
 * Spec: faux-model-testing → "Anthropic-messages agents use unprefixed tool names";
 *       subagent-spawn → plain-name tool activation, customTools, guard.
 *
 * Wire renaming for Anthropic is owned by pi-anthropic-messages (loaded into
 * every flow agent by the bridge plugin), not by pi-flows.
 */

import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { spawnFaux, scriptFinish, scriptToolThenFinish } from "./faux-harness.js";

function echoTool(name: string) {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: Type.Object({ x: Type.String() }),
    execute: async (_id: string, params: any) => ({
      content: [{ type: "text" as const, text: `${name}:${params.x}` }],
      details: {},
    }),
  };
}

describe("faux spawnAgent — anthropic-messages plain tool names", () => {
  it("finishes with plain `finish` and reports finishToolName as finish", async () => {
    const { result, finishToolName } = await spawnFaux({
      modelApi: "anthropic-messages",
      responses: [scriptFinish({ status: "complete", summary: "plain finish" })],
    });

    expect(finishToolName).toBe("finish");
    expect(result.success).toBe(true);
    expect(result.result.summary).toBe("plain finish");
  });

  it("does not recognise the legacy mcp__flows__finish name", async () => {
    const { result } = await spawnFaux({
      modelApi: "anthropic-messages",
      responses: [
        scriptFinish({ status: "complete", summary: "legacy" }, "mcp__flows__finish"),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("done"),
      ],
    });

    expect(result.result.summary).not.toBe("legacy");
  });

  it("registers, permits and reports extraCustomTools under their plain name", async () => {
    const seen: string[] = [];
    const { result } = await spawnFaux({
      modelApi: "anthropic-messages",
      agent: { tools: ["my_tool"] },
      extraCustomTools: [echoTool("my_tool")],
      onToolCall: (name) => seen.push(name),
      responses: scriptToolThenFinish("my_tool", { x: "hi" }, { status: "complete", summary: "used" }),
    });

    expect(result.success).toBe(true);
    expect(seen).toContain("my_tool");
    expect(seen.some((n) => n.startsWith("mcp__"))).toBe(false);
    const call = result.toolCalls.find((t) => t.toolName === "my_tool");
    expect(call).toBeDefined();
    expect(call!.isError).toBe(false);
  });

  it("keeps extension-registered tool names unprefixed", async () => {
    const { result } = await spawnFaux({
      modelApi: "anthropic-messages",
      agent: { tools: ["ext_tool"] },
      extraAgentExtensions: [(pi: any) => { pi.registerTool(echoTool("ext_tool")); }],
      responses: [
        fauxAssistantMessage([fauxToolCall("ext_tool", { x: "yo" })]),
        scriptFinish({ status: "complete", summary: "ext used" }),
      ],
    });

    expect(result.success).toBe(true);
    const call = result.toolCalls.find((t) => t.toolName === "ext_tool");
    expect(call).toBeDefined();
    expect(call!.isError).toBe(false);
    expect(call!.output).toBe("ext_tool:yo");
  });

  it("does not activate extension-registered tools the agent does not declare", async () => {
    // Observable signal (verified by spike): an inactive tool fails the SDK
    // lookup with "Tool <name> not found" BEFORE the guard runs; an active but
    // undeclared tool would instead be blocked with "not declared".
    const { result } = await spawnFaux({
      modelApi: "anthropic-messages",
      agent: { tools: ["declared_ext"] },
      extraAgentExtensions: [(pi: any) => {
        pi.registerTool(echoTool("declared_ext"));
        pi.registerTool(echoTool("undeclared_ext"));
      }],
      // One call per turn: parallel calls in one turn hit a separate,
      // pre-existing result-attribution issue (results keyed by position).
      responses: [
        fauxAssistantMessage([fauxToolCall("declared_ext", { x: "a" })]),
        fauxAssistantMessage([fauxToolCall("undeclared_ext", { x: "b" })]),
        scriptFinish({ status: "complete", summary: "mixed" }),
      ],
    });

    const declared = result.toolCalls.find((t) => t.toolName === "declared_ext");
    expect(declared!.isError).toBe(false);
    expect(declared!.output).toBe("declared_ext:a");

    const undeclared = result.toolCalls.find((t) => t.toolName === "undeclared_ext");
    expect(undeclared!.isError).toBe(true);
    expect(undeclared!.output).toBe("Tool undeclared_ext not found");
  });

  it("attributes parallel tool-call results to their own records", async () => {
    const results: Array<[string, unknown, boolean]> = [];
    const { result } = await spawnFaux({
      agent: { tools: ["tool_a", "tool_b"] },
      extraCustomTools: [echoTool("tool_a"), echoTool("tool_b")],
      onToolResult: (name, output, isError) => results.push([name, output, isError]),
      responses: [
        fauxAssistantMessage([
          fauxToolCall("tool_a", { x: "1" }),
          fauxToolCall("tool_b", { x: "2" }),
          fauxToolCall("not_a_tool", { x: "3" }),
        ]),
        scriptFinish({ status: "complete", summary: "parallel" }),
      ],
    });

    const rec = (n: string) => result.toolCalls.find((t) => t.toolName === n)!;
    expect(rec("tool_a").output).toBe("tool_a:1");
    expect(rec("tool_a").isError).toBe(false);
    expect(rec("tool_b").output).toBe("tool_b:2");
    expect(rec("tool_b").isError).toBe(false);
    expect(rec("not_a_tool").isError).toBe(true);

    expect(results).toContainEqual(["tool_a", "tool_a:1", false]);
    expect(results).toContainEqual(["tool_b", "tool_b:2", false]);
  });
});
