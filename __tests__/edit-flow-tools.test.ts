/**
 * Tests for the consolidated edit-flow tools introduced by
 * change `remove-flow-architect-main-session-authoring`:
 *
 *   - flow_agents  (op: "list" | "write")  — replaces agent_catalog + agent_write
 *   - flow_write   (namespace, name, content) — discovery-based, no raw path
 *
 * Both validate before writing and derive their write locations from the
 * discovery convention (.pi/flows/agents/<name>.md,
 * .pi/flows/flows/<namespace>/<name>.yaml). Tests run against a temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFlowAgentsTool } from "../extensions/flow-engine/tools/flow-agents.js";
import { registerFlowWriteTool } from "../extensions/flow-engine/tools/flow-write.js";
import type { AgentConfig } from "../extensions/flow-engine/types.js";

// ── Mock pi handle that captures registered tools + emitted events ──

interface CapturedTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function mkPi(allToolNames: string[] = []) {
  const tools = new Map<string, CapturedTool>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi: any = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return allToolNames.map((n) => ({ name: n }));
    },
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, tools, emitted };
}

async function call(tool: CapturedTool, params: unknown): Promise<any> {
  const result = await tool.execute("tc-1", params, undefined, undefined, {});
  return JSON.parse(result.content[0].text);
}

async function callRaw(tool: CapturedTool, params: unknown): Promise<any> {
  return await tool.execute("tc-1", params, undefined, undefined, {});
}

const VALID_AGENT = `---
name: my-agent
description: A test agent
model: "@coding"
tools: read, grep
---

# System Prompt

You do work: \${{task}}
`;

const INVALID_AGENT = `---
description: missing name and tools
model: "@coding"
---

body
`;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "edit-flow-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── flow_agents ──────────────────────────────────────────────────────────

describe("flow_agents — op: list", () => {
  it("returns the agent catalog", async () => {
    const { pi, tools } = mkPi();
    const agents = new Map<string, AgentConfig>([
      ["alpha", { name: "alpha", description: "A", model: "@coding", tools: ["read"] } as AgentConfig],
    ]);
    registerFlowAgentsTool(pi, () => agents, tmp, "/pkg", () => []);
    const out = await call(tools.get("flow_agents")!, { op: "list" });
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].name).toBe("alpha");
    expect(out[0].source_type).toBe("built-in");
  });

  it("populates a structured details catalog (count + agents)", async () => {
    const { pi, tools } = mkPi();
    const agents = new Map<string, AgentConfig>([
      ["alpha", { name: "alpha", description: "A", model: "@coding", tools: ["read"] } as AgentConfig],
      ["beta", { name: "beta", description: "B", model: "@coding", tools: ["read", "grep"], inputs: ["focus"] } as AgentConfig],
    ]);
    registerFlowAgentsTool(pi, () => agents, tmp, "/pkg", () => []);
    const raw = await callRaw(tools.get("flow_agents")!, { op: "list" });
    expect(raw.details.count).toBe(2);
    expect(raw.details.agents).toHaveLength(2);
    for (const e of raw.details.agents) {
      expect(typeof e.name).toBe("string");
      expect(typeof e.description).toBe("string");
      expect(typeof e.source_type).toBe("string");
    }
  });

  it("details entry flattens use_when and omits source_path for built-ins", async () => {
    const { pi, tools } = mkPi();
    const agents = new Map<string, AgentConfig>([
      ["alpha", { name: "alpha", description: "desc-A", model: "@coding", tools: ["read"] } as AgentConfig],
    ]);
    registerFlowAgentsTool(pi, () => agents, tmp, "/pkg", () => []);
    const raw = await callRaw(tools.get("flow_agents")!, { op: "list" });
    const e = raw.details.agents[0];
    expect(e.use_when).toBe("desc-A"); // no architect → falls back to description
    expect(e.source_path).toBeUndefined(); // built-in → no source_path
  });

  it("text payload still parses to the catalog array (unchanged)", async () => {
    const { pi, tools } = mkPi();
    const agents = new Map<string, AgentConfig>([
      ["alpha", { name: "alpha", description: "A", model: "@coding", tools: ["read"] } as AgentConfig],
    ]);
    registerFlowAgentsTool(pi, () => agents, tmp, "/pkg", () => []);
    const out = await call(tools.get("flow_agents")!, { op: "list" });
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].name).toBe("alpha");
  });
});

describe("flow_agents — op: write", () => {
  it("writes a valid agent to .pi/flows/agents/<name>.md and emits flow:rediscover", async () => {
    const { pi, tools, emitted } = mkPi();
    registerFlowAgentsTool(pi, () => new Map(), tmp, "/pkg", () => []);
    const out = await call(tools.get("flow_agents")!, { op: "write", content: VALID_AGENT });

    expect(out.written).toBe(true);
    expect(out.name).toBe("my-agent");
    const expectedPath = join(tmp, ".pi", "flows", "agents", "my-agent.md");
    expect(out.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toBe(VALID_AGENT);
    expect(emitted.some((e) => e.channel === "flow:rediscover")).toBe(true);
  });

  it("does not write when validation fails", async () => {
    const { pi, tools, emitted } = mkPi();
    registerFlowAgentsTool(pi, () => new Map(), tmp, "/pkg", () => []);
    const out = await call(tools.get("flow_agents")!, { op: "write", content: INVALID_AGENT });

    expect(out.written).toBe(false);
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, ".pi", "flows", "agents"))).toBe(false);
    expect(emitted.some((e) => e.channel === "flow:rediscover")).toBe(false);
  });

  it("does not accept a raw path parameter", () => {
    const { pi, tools } = mkPi();
    registerFlowAgentsTool(pi, () => new Map(), tmp, "/pkg", () => []);
    const props = (tools.get("flow_agents")! as any).parameters.properties;
    expect(props.path).toBeUndefined();
    expect(props.op).toBeDefined();
  });
});

// ── flow_write ─────────────────────────────────────────────────────────────

function flowYaml(agentName: string): string {
  return `name: my-flow
description: A test flow
steps:
  - id: step1
    type: agent
    agent: ${agentName}
    task: do \${{task}}
`;
}

function agentsWith(name: string): Map<string, AgentConfig> {
  return new Map([
    [name, { name, description: "x", model: "@coding", tools: ["read"] } as AgentConfig],
  ]);
}

describe("flow_write", () => {
  it("writes to .pi/flows/flows/<namespace>/<name>.yaml and reports the command", async () => {
    const { pi, tools, emitted } = mkPi();
    registerFlowWriteTool(pi, () => agentsWith("alpha"), tmp);
    const out = await call(tools.get("flow_write")!, {
      namespace: "team",
      name: "review",
      content: flowYaml("alpha"),
    });

    expect(out.written).toBe(true);
    expect(out.namespace).toBe("team");
    expect(out.command).toBe("team:review");
    const expectedPath = join(tmp, ".pi", "flows", "flows", "team", "review", "flow.yaml");
    expect(out.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(emitted.some((e) => e.channel === "flow:rediscover")).toBe(true);
  });

  it("defaults the namespace to \"custom\" when omitted", async () => {
    const { pi, tools } = mkPi();
    registerFlowWriteTool(pi, () => agentsWith("alpha"), tmp);
    const out = await call(tools.get("flow_write")!, { name: "thing", content: flowYaml("alpha") });

    expect(out.namespace).toBe("custom");
    expect(out.command).toBe("custom:thing");
    expect(existsSync(join(tmp, ".pi", "flows", "flows", "custom", "thing", "flow.yaml"))).toBe(true);
  });

  it("overwrites an existing flow (edit) on the same namespace/name", async () => {
    const { pi, tools } = mkPi();
    registerFlowWriteTool(pi, () => agentsWith("alpha"), tmp);
    const path = join(tmp, ".pi", "flows", "flows", "custom", "thing", "flow.yaml");

    await call(tools.get("flow_write")!, { name: "thing", content: flowYaml("alpha") });
    const second = flowYaml("alpha").replace("A test flow", "Edited flow");
    const out = await call(tools.get("flow_write")!, { name: "thing", content: second });

    expect(out.written).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("Edited flow");
  });

  it("does not write when validation fails (unknown agent)", async () => {
    const { pi, tools, emitted } = mkPi();
    registerFlowWriteTool(pi, () => new Map(), tmp);
    const out = await call(tools.get("flow_write")!, { name: "bad", content: flowYaml("ghost") });

    expect(out.written).toBe(false);
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, ".pi", "flows", "flows", "custom", "bad", "flow.yaml"))).toBe(false);
    expect(emitted.some((e) => e.channel === "flow:rediscover")).toBe(false);
  });

  it("surfaces generatedHandlers (.ts.default paths) for code nodes", async () => {
    const { pi, tools } = mkPi();
    registerFlowWriteTool(pi, () => agentsWith("alpha"), tmp);
    const content = `name: my-flow
description: A test flow
steps:
  - id: step1
    type: agent
    agent: alpha
    task: do \${{task}}
  - id: transform
    type: code
    outputs:
      - name: result
`;
    const out = await call(tools.get("flow_write")!, { name: "thing", content });

    expect(out.written).toBe(true);
    const expected = join(tmp, ".pi", "flows", "flows", "custom", "thing", "transform.ts.default");
    expect(out.generatedHandlers).toContain(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("does not accept a raw path parameter", () => {
    const { pi, tools } = mkPi();
    registerFlowWriteTool(pi, () => new Map(), tmp);
    const props = (tools.get("flow_write")! as any).parameters.properties;
    expect(props.path).toBeUndefined();
    expect(props.name).toBeDefined();
    expect(props.namespace).toBeDefined();
  });
});
