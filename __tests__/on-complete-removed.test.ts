/**
 * remove-on-complete-routing — `on_complete` is removed. Declaring it is a
 * validation error with a migration message; success falls through to the next
 * step; a reference formerly satisfied only by an `on_complete` chain no longer
 * validates.
 */
import { describe, it, expect } from "vitest";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";

const removedErr = (d: { message: string }) =>
  /on_complete/.test(d.message) && /remov/i.test(d.message);

describe("on_complete removal — validation", () => {
  it("rejects an agent step declaring on_complete", () => {
    const yaml = `
name: f
description: d
steps:
  - id: a
    type: agent
    agent: x
    on_complete: b
  - id: b
    type: agent
    agent: y
`;
    const { diagnostics } = validateFlowContent(yaml);
    expect(diagnostics.some(removedErr)).toBe(true);
  });

  it("rejects a code step declaring on_complete", () => {
    const yaml = `
name: f
description: d
steps:
  - id: a
    type: code
    on_complete: b
  - id: b
    type: code
`;
    const { diagnostics } = validateFlowContent(yaml);
    expect(diagnostics.some(removedErr)).toBe(true);
  });

  it("accepts on_error (unaffected by the removal)", () => {
    const yaml = `
name: f
description: d
steps:
  - id: a
    type: code
    on_error: b
  - id: b
    type: code
`;
    const { diagnostics } = validateFlowContent(yaml);
    expect(diagnostics.some(removedErr)).toBe(false);
  });

  it("a reference satisfied only by an on_complete chain no longer validates", () => {
    // b references a's output; ordering was previously proven by a.on_complete=b.
    const yaml = `
name: f
description: d
steps:
  - id: a
    type: code
    on_complete: b
    outputs:
      - name: token
  - id: b
    type: code
    inputs:
      t: \${{result.a.token}}
`;
    const { diagnostics } = validateFlowContent(yaml);
    // The on_complete removal error fires; and ordering is NOT satisfied via on_complete.
    expect(diagnostics.some(removedErr)).toBe(true);
    expect(
      diagnostics.some((d) => /result\.a|ordering|blockedBy|dependency/i.test(d.message) && d.severity === "error"),
    ).toBe(true);
  });
});
