// Edit-mode toggle helpers (add-edit-mode-toggle §1, §2, §3).
// Covers: project settings read-merge-write and arg parsing. (The project-local
// skill materialization was removed by stop-edit-mode-project-writes; see
// edit-mode-no-project-writes.test.ts.)

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { setEditFlowFlag, parseEditModeArg, readEditFlowFlag } from "../extensions/flow-engine/edit-flow-config.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-editmode-"));
}

// ── §1 settings write ──────────────────────────────────────────────────────

describe("setEditFlowFlag — project settings write (§1)", () => {
  it("creates .pi/settings.json when absent with flows.editFlow", () => {
    const root = tmpRoot();
    setEditFlowFlag(root, true);
    const path = join(root, ".pi", "settings.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.flows.editFlow).toBe(true);
  });

  it("preserves unrelated keys (read-merge-write)", () => {
    const root = tmpRoot();
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ theme: "dark", flows: { other: 1 }, top: "keep" }),
      "utf-8",
    );
    setEditFlowFlag(root, true);
    const parsed = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf-8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.top).toBe("keep");
    expect(parsed.flows.other).toBe(1); // sibling flows key kept
    expect(parsed.flows.editFlow).toBe(true);
  });

  it("round-trips through readEditFlowFlag", () => {
    const root = tmpRoot();
    setEditFlowFlag(root, false);
    const parsed = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf-8"));
    expect(readEditFlowFlag(parsed)).toBe(false);
  });
});

// ── §3.3 arg parsing ─────────────────────────────────────────────────────────

describe("parseEditModeArg (§3.3)", () => {
  it("parses on/off", () => {
    expect(parseEditModeArg("on")).toBe(true);
    expect(parseEditModeArg("OFF")).toBe(false);
    expect(parseEditModeArg(" on ")).toBe(true);
  });
  it("returns null for invalid/empty", () => {
    expect(parseEditModeArg("")).toBeNull();
    expect(parseEditModeArg(undefined)).toBeNull();
    expect(parseEditModeArg("maybe")).toBeNull();
  });
});
