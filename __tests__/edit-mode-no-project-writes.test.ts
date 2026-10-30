// stop-edit-mode-project-writes — behaviour derived from the spec delta:
//   - No implicit project writes (session_start / per-turn never touch the repo)
//   - Packaged skill registration (manage-flows shipped by the package)
//   - Skill visibility computed per turn from the effective flows.editFlow
//     (project overrides global), leftover project copies ignored
//   - Explicit toggle writes only project settings, skips no-op writes, no reload
//
// Drives the REAL extension `activate()` against a temp git repo (cwd) and a
// temp HOME (global settings), through a minimal fake pi host.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate } from "../extensions/flow-engine/index.js";
import { setEditFlowFlag } from "../extensions/flow-engine/edit-flow-config.js";

const PKG_ROOT = join(__dirname, "..");
const AUTHORING_TOOLS = ["flow_agents", "flow_write"];

// ── fixtures ────────────────────────────────────────────────────────────────

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flows-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).trim();
}

function writeJson(path: string, obj: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function setGlobal(home: string, editFlow: boolean | undefined) {
  const p = join(home, ".pi", "agent", "settings.json");
  writeJson(p, editFlow === undefined ? {} : { flows: { editFlow } });
}

/** path → { mtimeMs, sha } for every file under dir (excluding .git). */
function snapshot(dir: string): Record<string, { mtimeMs: number; sha: string }> {
  const out: Record<string, { mtimeMs: number; sha: string }> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = { mtimeMs: st.mtimeMs, sha: createHash("sha256").update(readFileSync(p)).digest("hex") };
    }
  };
  walk(dir);
  return out;
}

function skill(name: string, filePath: string, disableModelInvocation: boolean) {
  return { name, description: `${name} skill`, filePath, baseDir: join(filePath, ".."), sourceInfo: {}, disableModelInvocation };
}

/** Minimal pi host: lifecycle handlers, event bus, active tools, commands. */
function host() {
  const lifecycle = new Map<string, Array<(e: any, c: any) => any>>();
  const bus = new Map<string, Array<(d: any) => any>>();
  const commands = new Map<string, any>();
  let active: string[] = ["read", "bash"];
  const base: Record<string, unknown> = {
    on: (n: string, h: any) => lifecycle.set(n, [...(lifecycle.get(n) ?? []), h]),
    events: {
      on: (n: string, h: any) => { bus.set(n, [...(bus.get(n) ?? []), h]); return () => undefined; },
      emit: (n: string, d?: any) => { for (const h of bus.get(n) ?? []) h(d); },
    },
    registerCommand: (n: string, def: any) => commands.set(n, def),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    getAllTools: () => [],
  };
  const pi = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : () => undefined) }) as any;
  const ctx = (cwd: string) => ({ cwd, hasUI: false, ui: { notify: () => undefined } });

  return {
    pi,
    commands,
    get active() { return active; },
    async fire(name: string, event: any, cwd: string) {
      let last: any;
      for (const h of lifecycle.get(name) ?? []) last = (await h({ type: name, ...event }, ctx(cwd))) ?? last;
      return last;
    },
    async emit(name: string, data: any) {
      await Promise.all((bus.get(name) ?? []).map((h) => h(data)));
    },
  };
}

type Host = ReturnType<typeof host>;

/** Run one agent turn; return the skill list as the model would see it. */
async function turn(h: Host, cwd: string, skills: any[]) {
  const event = {
    messageType: "user",
    prompt: "hi",
    systemPrompt: "",
    systemPromptOptions: { cwd, skills: skills.map((s) => ({ ...s })), selectedTools: [], hiddenTools: [], sections: {} },
  };
  await h.fire("before_agent_start", event, cwd);
  return event.systemPromptOptions.skills as Array<ReturnType<typeof skill>>;
}

/** Is manage-flows listed to the model for this turn? */
const modelSeesManageFlows = (skills: Array<ReturnType<typeof skill>>) =>
  skills.some((s) => s.name === "manage-flows" && !s.disableModelInvocation);

const PACKAGED_SKILL = skill("manage-flows", join(PKG_ROOT, "skills", "manage-flows", "SKILL.md"), false);
const OTHER_SKILL = skill("other", "/x/other/SKILL.md", false);

// ── harness lifecycle ───────────────────────────────────────────────────────

let repo: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  repo = gitRepo();
  home = mkdtempSync(join(tmpdir(), "pi-flows-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() honours HOME on POSIX
  vi.spyOn(process, "cwd").mockReturnValue(repo);
});

afterEach(() => {
  process.env.HOME = savedHome;
  vi.restoreAllMocks();
});

async function boot(): Promise<Host> {
  const h = host();
  activate(h.pi);
  await h.fire("session_start", { reason: "startup" }, repo);
  return h;
}

// ── No implicit project writes ──────────────────────────────────────────────

describe("No implicit project writes", () => {
  it("clean repo, edit-mode off everywhere: git status stays clean, no .pi files created", async () => {
    const h = await boot();
    await turn(h, repo, [PACKAGED_SKILL]);

    expect(existsSync(join(repo, ".pi", "skills", "manage-flows"))).toBe(false);
    expect(existsSync(join(repo, ".pi", "settings.json"))).toBe(false);
    expect(gitStatus(repo)).toBe("");
  });

  it("clean repo, global editFlow:true: tools active, skill model-visible, git status clean", async () => {
    setGlobal(home, true);
    const h = await boot();
    const skills = await turn(h, repo, [PACKAGED_SKILL, OTHER_SKILL]);

    expect(h.active).toEqual(expect.arrayContaining(AUTHORING_TOOLS));
    expect(modelSeesManageFlows(skills)).toBe(true);
    expect(gitStatus(repo)).toBe("");
  });

  it("repeated session starts with no setting change: no file mtime or content changes", async () => {
    // Leftover state from the old behaviour, committed.
    writeJson(join(repo, ".pi", "settings.json"), { other: 1, flows: { editFlow: true } });
    mkdirSync(join(repo, ".pi", "skills", "manage-flows"), { recursive: true });
    writeFileSync(join(repo, ".pi", "skills", "manage-flows", "SKILL.md"), "---\nname: manage-flows\ndescription: d\ndisable-model-invocation: true\n---\n\nbody\n");
    const before = snapshot(repo);

    await new Promise((r) => setTimeout(r, 20)); // make any rewrite visible in mtime
    const h1 = await boot();
    await turn(h1, repo, [PACKAGED_SKILL]);
    const h2 = await boot();
    await turn(h2, repo, [PACKAGED_SKILL]);

    expect(snapshot(repo)).toEqual(before);
  });

  it("does not write the global settings or global skills directory either", async () => {
    setGlobal(home, true);
    const before = snapshot(home);
    const h = await boot();
    await turn(h, repo, [PACKAGED_SKILL]);

    expect(snapshot(home)).toEqual(before);
    expect(existsSync(join(home, ".pi", "agent", "skills", "manage-flows"))).toBe(false);
  });
});

// ── Packaged skill registration ─────────────────────────────────────────────

describe("Packaged skill registration", () => {
  it("the package manifest ships the manage-flows skill", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    const skillDirs: string[] = pkg.pi?.skills ?? [];
    const shipped = skillDirs.some((d) => existsSync(join(PKG_ROOT, d, "manage-flows", "SKILL.md")));
    expect(shipped).toBe(true);
  });

  it("the packaged SKILL.md is never written", async () => {
    const path = join(PKG_ROOT, "skills", "manage-flows", "SKILL.md");
    const before = statSync(path).mtimeMs;
    setGlobal(home, true);
    const h = await boot();
    await turn(h, repo, [PACKAGED_SKILL]);
    await h.commands.get("flows:edit-mode").handler("off", { cwd: repo, ui: { notify: () => undefined }, reload: async () => undefined });
    expect(statSync(path).mtimeMs).toBe(before);
  });
});

// ── Per-turn visibility ─────────────────────────────────────────────────────

describe("Skill visibility follows the effective setting per turn", () => {
  it("edit-mode off: manage-flows is not listed to the model; other skills untouched", async () => {
    const h = await boot();
    const skills = await turn(h, repo, [PACKAGED_SKILL, OTHER_SKILL]);

    expect(modelSeesManageFlows(skills)).toBe(false);
    expect(skills.find((s) => s.name === "other")?.disableModelInvocation).toBe(false);
  });

  it("global flip mid-session reaches tools and skill visibility on the next turn", async () => {
    setGlobal(home, false);
    const h = await boot();
    expect(modelSeesManageFlows(await turn(h, repo, [PACKAGED_SKILL]))).toBe(false);
    expect(h.active).not.toContain("flow_write");

    setGlobal(home, true);
    expect(modelSeesManageFlows(await turn(h, repo, [PACKAGED_SKILL]))).toBe(true);
    expect(h.active).toEqual(expect.arrayContaining(AUTHORING_TOOLS));

    setGlobal(home, false);
    expect(modelSeesManageFlows(await turn(h, repo, [PACKAGED_SKILL]))).toBe(false);
    expect(h.active).not.toContain("flow_write");
  });

  it("project value overrides global for skill visibility", async () => {
    setGlobal(home, true);
    writeJson(join(repo, ".pi", "settings.json"), { flows: { editFlow: false } });
    const h = await boot();
    expect(modelSeesManageFlows(await turn(h, repo, [PACKAGED_SKILL]))).toBe(false);
    expect(h.active).not.toContain("flow_agents");
  });

  it("leftover project copy with disable-model-invocation:true is shown when edit-mode is on", async () => {
    setGlobal(home, true);
    const leftover = skill("manage-flows", join(repo, ".pi", "skills", "manage-flows", "SKILL.md"), true);
    const h = await boot();
    expect(modelSeesManageFlows(await turn(h, repo, [leftover]))).toBe(true);
  });

  it("leftover project copy with disable-model-invocation:false is hidden when edit-mode is off", async () => {
    const leftover = skill("manage-flows", join(repo, ".pi", "skills", "manage-flows", "SKILL.md"), false);
    const h = await boot();
    expect(modelSeesManageFlows(await turn(h, repo, [leftover]))).toBe(false);
  });
});

// ── Explicit toggle ─────────────────────────────────────────────────────────

describe("Explicit toggle writes only project settings", () => {
  it("/flows:edit-mode on: project settings get editFlow:true, overrides global false, no skill file, no reload", async () => {
    setGlobal(home, false);
    const h = await boot();
    const reload = vi.fn(async () => undefined);
    await h.commands.get("flows:edit-mode").handler("on", { cwd: repo, ui: { notify: () => undefined }, reload });

    const settings = JSON.parse(readFileSync(join(repo, ".pi", "settings.json"), "utf8"));
    expect(settings.flows.editFlow).toBe(true);
    expect(existsSync(join(repo, ".pi", "skills"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    expect(modelSeesManageFlows(await turn(h, repo, [PACKAGED_SKILL]))).toBe(true);
    expect(h.active).toEqual(expect.arrayContaining(AUTHORING_TOOLS));
  });

  it("flow:set-edit-mode {enabled:false}: project settings written, no skill file, hidden next turn", async () => {
    setGlobal(home, true);
    const h = await boot();
    await h.emit("flow:set-edit-mode", { enabled: false });
    await new Promise((r) => setTimeout(r, 0));

    const settings = JSON.parse(readFileSync(join(repo, ".pi", "settings.json"), "utf8"));
    expect(settings.flows.editFlow).toBe(false);
    expect(existsSync(join(repo, ".pi", "skills"))).toBe(false);
    expect(modelSeesManageFlows(await turn(h, repo, [PACKAGED_SKILL]))).toBe(false);
    expect(h.active).not.toContain("flow_agents");
  });

  it("setEditFlowFlag skips the write when the value is already set", async () => {
    const path = join(repo, ".pi", "settings.json");
    writeJson(path, { other: 1, flows: { editFlow: true } });
    const before = snapshot(repo);
    await new Promise((r) => setTimeout(r, 20));

    setEditFlowFlag(repo, true);

    expect(snapshot(repo)).toEqual(before);
  });
});
