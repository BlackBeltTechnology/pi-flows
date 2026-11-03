// Validator: ordering of `${{result.X}}` references for separator steps.
// spec: flow-wiring "Referenced results must be ordered before use".
// Non-agent steps (agent-decision, fork, code, code-decision) are separators:
// the engine runs them only after every earlier segment has finished
// (splitIntoSegments / runFlow), so ANY earlier step (file order) is ordered
// before them without a `blockedBy`. Agent steps in a parallel group keep the
// blockedBy-based rule.
import { describe, expect, it } from "vitest";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n---\n\nYou are ${name}.\n`;
const catalog = () =>
  new Map(["developer", "verifier", "summarizer", "worker"].map((n) => [n, parseAgentString(agentMd(n), "<t>")]));
const validate = (yaml: string) => validateFlowContent(yaml, catalog, () => true);
const errorsOf = (yaml: string) => validate(yaml).diagnostics.filter((d) => d.severity === "error");
const orderingErrors = (yaml: string) => errorsOf(yaml).filter((e) => /ordered before/.test(e.message));

describe("validator: references from separator steps", () => {
  it("docs example: agent-decision task referencing an earlier agent validates cleanly", () => {
    const yaml = `name: loop
description: verify loop
steps:
  - id: developer
    type: agent
    agent: developer
    task: Implement it
  - id: verify-loop
    type: agent-decision
    agent: verifier
    task: >
      Check implementation (attempt \${{loop.verify-loop.iteration}}/\${{loop.verify-loop.max}}).
      Developer output: \${{result.developer.summary}}
    branches:
      rework: developer
      done: finalize
    max_iterations: 3
  - id: finalize
    type: agent
    agent: summarizer
    task: Summarize
`;
    expect(errorsOf(yaml)).toEqual([]);
  });

  it("a fork question referencing an earlier agent validates", () => {
    const yaml = `name: f
description: fork
steps:
  - id: developer
    type: agent
    agent: developer
    task: Implement it
  - id: ask
    type: fork
    question: "Ship? Dev said: \${{result.developer.summary}}"
    options: [ship, hold]
    branches:
      ship: ship
      hold: hold
  - id: ship
    type: agent
    agent: worker
    task: SHIP
  - id: hold
    type: agent
    agent: worker
    task: HOLD
`;
    expect(orderingErrors(yaml)).toEqual([]);
    expect(errorsOf(yaml)).toEqual([]);
  });

  it("a code-decision input and a decision state: value referencing an earlier agent validate", () => {
    const yaml = `name: c
description: code decision
steps:
  - id: developer
    type: agent
    agent: developer
    task: Implement it
  - id: gate
    type: code-decision
    target: ./gate.mjs
    inputs:
      dev: "\${{result.developer.summary}}"
    branches:
      a: left
      b: right
  - id: judge
    type: agent-decision
    agent: verifier
    task: decide
    state:
      dev: "\${{result.developer.summary}}"
    branches:
      a: left
      b: right
  - id: left
    type: agent
    agent: worker
    task: LEFT
  - id: right
    type: agent
    agent: worker
    task: RIGHT
`;
    expect(orderingErrors(yaml)).toEqual([]);
  });

  it("a decision referencing a LATER step is still an error", () => {
    const yaml = `name: later
description: forward ref
steps:
  - id: a
    type: agent
    agent: worker
    task: A
  - id: pick
    type: agent-decision
    agent: verifier
    task: "decide using \${{result.b.summary}}"
    branches:
      x: a
      y: b
    max_iterations: 2
  - id: b
    type: agent
    agent: worker
    task: B
`;
    const errs = orderingErrors(yaml);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toContain('"b"');
  });

  it("a fork question or decision state: referencing a LATER step is an error", () => {
    const base = (extra: string) => `name: later2
description: forward ref
steps:
  - id: a
    type: agent
    agent: worker
    task: A
  - id: pick
    type: agent-decision
    agent: verifier
    task: decide
${extra}    branches:
      x: b
      y: c
  - id: b
    type: agent
    agent: worker
    task: B
  - id: c
    type: agent
    agent: worker
    task: C
`;
    expect(orderingErrors(base('    state:\n      k: "${{result.c.summary}}"\n')).length).toBeGreaterThan(0);
  });

  it("a fork question referencing a LATER step is an error", () => {
    const yaml = `name: later3
description: forward ref
steps:
  - id: ask
    type: fork
    question: "Ship? \${{result.b.summary}}"
    options: [ship, hold]
    branches:
      ship: b
      hold: c
  - id: b
    type: agent
    agent: worker
    task: B
  - id: c
    type: agent
    agent: worker
    task: C
`;
    expect(orderingErrors(yaml).length).toBeGreaterThan(0);
  });

  it("an agent step referencing a sibling in its parallel group without blockedBy is still an error", () => {
    const yaml = `name: par
description: parallel group
steps:
  - id: a
    type: agent
    agent: worker
    task: A
  - id: b
    type: agent
    agent: worker
    task: "B uses \${{result.a.summary}}"
`;
    const errs = orderingErrors(yaml);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toContain('"a"');
  });
});
