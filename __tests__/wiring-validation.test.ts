// Fail-loud reference + ordering validation (harden-flow-wiring §2, §3).
// A template reference to an unknown step, an unknown output field, or a step
// that is not ordered-before the referencing step must be a hard validation
// error at flow-load time — not a silent empty-string at runtime.

import { describe, expect, it } from "vitest";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import type { AgentConfig } from "../extensions/flow-engine/types.js";

function agent(name: string, outputs?: string[]): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    model: "@coding",
    tools: ["read"],
    systemPrompt: "do $\{{input.x}}",
    source: `${name}.md`,
    ...(outputs ? { outputs: outputs.map((n) => ({ name: n })) } : {}),
  };
}

function catalog(...agents: AgentConfig[]): () => Map<string, AgentConfig> {
  const m = new Map<string, AgentConfig>();
  for (const a of agents) m.set(a.name, a);
  return () => m;
}

const errs = (yaml: string, cat?: () => Map<string, AgentConfig>) =>
  validateFlowContent(yaml, cat).diagnostics.filter((d) => d.severity === "error");

describe("unknown reference rejection (§2)", () => {
  it("rejects a reference to an unknown step ID", () => {
    const yaml = `name: f
description: d
steps:
  - id: b
    type: agent
    agent: my-agent
    task: "use $\{{result.nonexistent.summary}}"
`;
    const e = errs(yaml, catalog(agent("my-agent")));
    expect(e.some((d) => d.message.includes("nonexistent"))).toBe(true);
  });

  it("rejects a typo in an output field of a known agent", () => {
    const yaml = `name: f
description: d
steps:
  - id: extract
    type: agent
    agent: extractor
  - id: b
    type: agent
    agent: my-agent
    blockedBy: [extract]
    task: "use $\{{result.extract.totl}}"
`;
    const e = errs(yaml, catalog(agent("my-agent"), agent("extractor", ["total"])));
    expect(e.some((d) => d.message.includes("totl"))).toBe(true);
  });

  it("accepts a declared output field of a known agent", () => {
    const yaml = `name: f
description: d
steps:
  - id: extract
    type: agent
    agent: extractor
  - id: b
    type: agent
    agent: my-agent
    blockedBy: [extract]
    task: "use $\{{result.extract.total}}"
`;
    expect(errs(yaml, catalog(agent("my-agent"), agent("extractor", ["total"])))).toHaveLength(0);
  });

  it("accepts standard fields regardless of declared outputs", () => {
    const yaml = `name: f
description: d
steps:
  - id: extract
    type: agent
    agent: extractor
  - id: b
    type: agent
    agent: my-agent
    blockedBy: [extract]
    task: "$\{{result.extract.summary}} $\{{result.extract.status}} $\{{result.extract.artifacts}} $\{{result.extract.files}}"
`;
    expect(errs(yaml, catalog(agent("my-agent"), agent("extractor")))).toHaveLength(0);
  });

  it("rejects an unknown field on a code node by its declared outputs", () => {
    const yaml = `name: f
description: d
steps:
  - id: calc
    type: code
    outputs:
      - name: total
  - id: b
    type: agent
    agent: my-agent
    blockedBy: [calc]
    task: "use $\{{result.calc.totl}}"
`;
    const e = errs(yaml, catalog(agent("my-agent")));
    expect(e.some((d) => d.message.includes("totl"))).toBe(true);
  });
});

describe("ordering validation: blockedBy + routing reachability (§3)", () => {
  it("rejects a reference to a step that is not ordered-before", () => {
    const yaml = `name: f
description: d
steps:
  - id: a
    type: agent
    agent: my-agent
  - id: b
    type: agent
    agent: my-agent
    task: "use $\{{result.a.summary}}"
`;
    // b references a but neither blockedBy nor routing orders a before b.
    const e = errs(yaml, catalog(agent("my-agent")));
    expect(e.some((d) => d.message.includes("a") && /order|depend|blockedBy/i.test(d.message))).toBe(true);
  });

  it("accepts a reference satisfied by transitive blockedBy", () => {
    const yaml = `name: f
description: d
steps:
  - id: a
    type: agent
    agent: my-agent
  - id: mid
    type: agent
    agent: my-agent
    blockedBy: [a]
  - id: b
    type: agent
    agent: my-agent
    blockedBy: [mid]
    task: "use $\{{result.a.summary}}"
`;
    expect(errs(yaml, catalog(agent("my-agent")))).toHaveLength(0);
  });

  it("accepts a reference satisfied by on_complete routing without blockedBy", () => {
    const yaml = `name: f
description: d
steps:
  - id: a
    type: agent
    agent: my-agent
    on_complete: b
  - id: b
    type: agent
    agent: my-agent
    task: "use $\{{result.a.summary}}"
`;
    expect(errs(yaml, catalog(agent("my-agent")))).toHaveLength(0);
  });

  it("does not false-positive on sub-flow results when a flow-ref is ordered-before", () => {
    const yaml = `name: f
description: d
steps:
  - id: sub
    type: flow-ref
    path: ./sub.yaml
    on_complete: b
  - id: b
    type: agent
    agent: my-agent
    task: "use $\{{result.inner.summary}}"
`;
    // `inner` is a sub-flow step, not statically known; must NOT error.
    expect(errs(yaml, catalog(agent("my-agent")))).toHaveLength(0);
  });
});
