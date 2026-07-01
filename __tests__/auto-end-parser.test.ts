/**
 * flow-auto-end-session, task 1.1 — parser exposes the top-level `auto_end`
 * flow key; omission yields a falsy value.
 */
import { describe, it, expect } from "vitest";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";

const withAutoEnd = `
name: t
description: d
auto_end: true
steps:
  - id: a
    type: agent
    agent: x
`;

const withoutAutoEnd = `
name: t
description: d
steps:
  - id: a
    type: agent
    agent: x
`;

describe("flow auto_end parsing", () => {
  it("exposes auto_end === true when set", () => {
    const flow = parseFlowYamlString(withAutoEnd, "t.yaml");
    expect(flow.auto_end).toBe(true);
  });

  it("auto_end is falsy when omitted", () => {
    const flow = parseFlowYamlString(withoutAutoEnd, "t.yaml");
    expect(flow.auto_end).toBeFalsy();
  });
});
