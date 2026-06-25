// Edit-mode toggle helpers (add-edit-mode-toggle §1, §2, §3).
// Covers: project settings read-merge-write, arg parsing, project-local skill
// materialization + disable-model-invocation frontmatter sync, and the
// never-write-node_modules guarantee.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { setEditFlowFlag, parseEditModeArg, readEditFlowFlag } from "../extensions/flow-engine/edit-flow-config.js";
import {
  setDisableModelInvocation,
  syncEditFlowSkill,
  editFlowSkillPath,
} from "../extensions/flow-engine/edit-flow-skill.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-editmode-"));
}

function tmpPkg(skillBody?: string): string {
  const pkg = mkdtempSync(join(tmpdir(), "pi-editpkg-"));
  if (skillBody !== undefined) {
    const dir = join(pkg, "skills", "edit-flow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillBody, "utf-8");
  }
  return pkg;
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

// ── §2 frontmatter sync ──────────────────────────────────────────────────────

describe("setDisableModelInvocation (§2)", () => {
  it("replaces an existing key, preserving other frontmatter and body", () => {
    const src = "---\nname: edit-flow\ndisable-model-invocation: false\ndescription: d\n---\n\n# Body\ntext";
    const out = setDisableModelInvocation(src, true);
    expect(out).toContain("disable-model-invocation: true");
    expect(out).not.toContain("disable-model-invocation: false");
    expect(out).toContain("name: edit-flow");
    expect(out).toContain("description: d");
    expect(out).toContain("# Body\ntext");
  });

  it("adds the key when frontmatter lacks it", () => {
    const src = "---\nname: edit-flow\n---\n\n# Body";
    const out = setDisableModelInvocation(src, true);
    expect(out).toContain("disable-model-invocation: true");
    expect(out).toContain("name: edit-flow");
    expect(out).toContain("# Body");
  });

  it("prepends a frontmatter block when none exists", () => {
    const out = setDisableModelInvocation("# Just a body", false);
    expect(out.startsWith("---\ndisable-model-invocation: false\n---")).toBe(true);
    expect(out).toContain("# Just a body");
  });
});

describe("syncEditFlowSkill — project-local materialization (§2)", () => {
  const template = "---\nname: edit-flow\ndescription: desc\n---\n\n# Edit Flow\nguidance";

  it("materializes from the packaged template when absent and sets disable-model-invocation", () => {
    const root = tmpRoot();
    const pkg = tmpPkg(template);
    const res = syncEditFlowSkill(root, pkg, false); // disabled → hidden
    expect(res.created).toBe(true);
    expect(res.path).toBe(editFlowSkillPath(root));
    const content = readFileSync(res.path, "utf-8");
    expect(content).toContain("disable-model-invocation: true");
    expect(content).toContain("# Edit Flow"); // body carried over
  });

  it("enabled → disable-model-invocation false (AI sees it)", () => {
    const root = tmpRoot();
    const pkg = tmpPkg(template);
    syncEditFlowSkill(root, pkg, true);
    const content = readFileSync(editFlowSkillPath(root), "utf-8");
    expect(content).toContain("disable-model-invocation: false");
  });

  it("is idempotent and flips the flag on the existing project-local copy", () => {
    const root = tmpRoot();
    const pkg = tmpPkg(template);
    const first = syncEditFlowSkill(root, pkg, true);
    expect(first.created).toBe(true);
    const second = syncEditFlowSkill(root, pkg, false);
    expect(second.created).toBe(false); // already existed
    expect(readFileSync(second.path, "utf-8")).toContain("disable-model-invocation: true");
  });

  it("NEVER writes under the packaged (node_modules) skills dir", () => {
    const root = tmpRoot();
    const pkg = tmpPkg(template);
    const before = readFileSync(join(pkg, "skills", "edit-flow", "SKILL.md"), "utf-8");
    syncEditFlowSkill(root, pkg, false);
    syncEditFlowSkill(root, pkg, true);
    expect(readFileSync(join(pkg, "skills", "edit-flow", "SKILL.md"), "utf-8")).toBe(before);
  });

  it("falls back to a built-in template when the package template is missing", () => {
    const root = tmpRoot();
    const pkg = tmpPkg(); // no template shipped
    const res = syncEditFlowSkill(root, pkg, true);
    expect(res.created).toBe(true);
    const content = readFileSync(res.path, "utf-8");
    expect(content).toContain("name: edit-flow");
    expect(content).toContain("disable-model-invocation: false");
  });
});
