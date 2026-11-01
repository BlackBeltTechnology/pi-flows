import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFlowsSettings } from "../extensions/flow-engine/flows-settings.js";

let home: string;
let proj: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fs-home-"));
  proj = mkdtempSync(join(tmpdir(), "fs-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});
const put = (base: string, sub: string[], flows: unknown) => {
  const dir = join(base, ...sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ flows }));
};

describe("readFlowsSettings", () => {
  it("defaults: modelFallback session, no decisionAgent", () => {
    expect(readFlowsSettings(proj, { home })).toEqual({ modelFallback: "session", decisionAgent: undefined, warnings: [] });
  });

  it("project overrides global", () => {
    put(home, [".pi", "agent"], { modelFallback: "error", decisionAgent: "g-router" });
    put(proj, [".pi"], { modelFallback: "session", decisionAgent: "p-router" });
    const s = readFlowsSettings(proj, { home });
    expect(s.modelFallback).toBe("session");
    expect(s.decisionAgent).toBe("p-router");
  });

  it("global applies when project silent", () => {
    put(home, [".pi", "agent"], { modelFallback: "error", decisionAgent: "g-router" });
    const s = readFlowsSettings(proj, { home });
    expect(s.modelFallback).toBe("error");
    expect(s.decisionAgent).toBe("g-router");
  });

  it("invalid modelFallback → default + warning", () => {
    put(proj, [".pi"], { modelFallback: "bogus" });
    const s = readFlowsSettings(proj, { home });
    expect(s.modelFallback).toBe("session");
    expect(s.warnings.join(" ")).toContain("bogus");
  });
});
