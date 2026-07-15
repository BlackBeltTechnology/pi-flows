/**
 * Tests for the `flows.editFlow` setting that gates the edit-flow tools
 * (change: remove-flow-architect-main-session-authoring).
 *
 * Resolution: project `.pi/settings.json` overrides global
 * `~/<.pi>/agent/settings.json`; default disabled. No trust gate — the project
 * setting is honored regardless of project trust (change: apply-editflow-setting-live).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEditFlowEnabled, readEditFlowFlag } from "../extensions/flow-engine/edit-flow-config.js";

describe("readEditFlowFlag", () => {
  it("reads nested flows.editFlow", () => {
    expect(readEditFlowFlag({ flows: { editFlow: true } })).toBe(true);
    expect(readEditFlowFlag({ flows: { editFlow: false } })).toBe(false);
  });
  it("reads top-level flowsEditFlow alias", () => {
    expect(readEditFlowFlag({ flowsEditFlow: true })).toBe(true);
  });
  it("returns undefined when absent or wrong type", () => {
    expect(readEditFlowFlag({})).toBeUndefined();
    expect(readEditFlowFlag({ flows: { editFlow: "yes" } })).toBeUndefined();
    expect(readEditFlowFlag(null)).toBeUndefined();
  });
});

describe("isEditFlowEnabled", () => {
  let home: string;
  let project: string;

  function writeSettings(dir: string, sub: string[], obj: unknown) {
    const d = join(dir, ...sub);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "settings.json"), JSON.stringify(obj), "utf-8");
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "auth-home-"));
    project = mkdtempSync(join(tmpdir(), "auth-proj-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("defaults to false when nothing set", () => {
    expect(isEditFlowEnabled(project, { home })).toBe(false);
  });

  it("honors the global setting", () => {
    writeSettings(home, [".pi", "agent"], { flows: { editFlow: true } });
    expect(isEditFlowEnabled(project, { home })).toBe(true);
  });

  it("lets the project setting override global", () => {
    writeSettings(home, [".pi", "agent"], { flows: { editFlow: true } });
    writeSettings(project, [".pi"], { flows: { editFlow: false } });
    expect(isEditFlowEnabled(project, { home })).toBe(false);
  });

  it("honors the project setting regardless of trust (no gate)", () => {
    writeSettings(project, [".pi"], { flows: { editFlow: true } });
    expect(isEditFlowEnabled(project, { home })).toBe(true);
  });
});
