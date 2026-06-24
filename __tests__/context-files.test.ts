/**
 * Tests for `loadContextFiles` — reads declared context files and returns
 * preamble sections, separating missing/unreadable paths (spec `agent-node`,
 * change: enhance-agent-node-contract).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextFiles } from "../extensions/flow-engine/execution.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-flows-ctx-"));
  writeFileSync(join(dir, "AGENTS.md"), "# Conventions\nUse tabs.");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "extra.md"), "Extra context.");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadContextFiles", () => {
  it("reads files and wraps each as a `## Context: <path>` section", () => {
    const { sections, missing, unreadable } = loadContextFiles(dir, ["AGENTS.md", "docs/extra.md"]);
    expect(missing).toEqual([]);
    expect(unreadable).toEqual([]);
    expect(sections).toEqual([
      "## Context: AGENTS.md\n\n# Conventions\nUse tabs.",
      "## Context: docs/extra.md\n\nExtra context.",
    ]);
  });

  it("skips a missing file (non-fatal) and still returns the found ones", () => {
    const { sections, missing } = loadContextFiles(dir, ["AGENTS.md", "nope.md"]);
    expect(missing).toEqual(["nope.md"]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("## Context: AGENTS.md");
  });

  it("undefined/empty list → no sections", () => {
    expect(loadContextFiles(dir, undefined).sections).toEqual([]);
    expect(loadContextFiles(dir, []).sections).toEqual([]);
  });
});
