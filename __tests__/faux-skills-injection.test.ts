/**
 * Characterization tests for `skills:` advertising (pi-parity).
 *
 * `agent.skills` frontmatter resolves each skill to a pi `Skill` object, which
 * is advertised in the subagent's system prompt via pi's `formatSkillsForPrompt`
 * — name + description + <location> only, NOT the SKILL.md body. The agent then
 * loads SKILL.md and its topic files on demand with `read` (progressive
 * disclosure), exactly like pi's main session. There is no `skill_read` tool.
 *
 * These tests drive the real `spawnAgent` loop and assert (a) the advertised
 * block reaches `context.systemPrompt` without the body, and (b) the agent can
 * actually `read` the advertised SKILL.md — proving `read` is auto-granted and
 * the skill dir is whitelisted even under a restrictive `access.read`.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";

import { spawnFaux, scriptFinish, scriptToolThenFinish, type FauxResponseStep } from "./faux-harness.js";

let skillDir: string;
let skillMdPath: string;
let skills: Skill[];

beforeAll(() => {
  // A real on-disk skill: SKILL.md (index) + a topic file (detail).
  const root = mkdtempSync(join(tmpdir(), "faux-skills-"));
  skillDir = join(root, "docs-x");
  mkdirSync(skillDir, { recursive: true });
  skillMdPath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillMdPath,
    "---\nname: docs-x\ndescription: Backend docs for the widget service\n---\n\n" +
      "# Docs X\n\nSee references/api.md.\nSENTINEL_SKILL_BODY_XYZ\n",
    "utf8",
  );
  const refs = join(skillDir, "references");
  mkdirSync(refs, { recursive: true });
  writeFileSync(join(refs, "api.md"), "TOPIC_FILE_BODY\n", "utf8");

  const loaded = loadSkillsFromDir({ dir: skillDir, source: "test" });
  skills = loaded.skills;
});

/** A faux factory that records the live system prompt, then finishes. */
function captureSystemPrompt(sink: { prompt: string }): FauxResponseStep {
  return ((context: any) => {
    sink.prompt = context?.systemPrompt ?? "";
    return scriptFinish({ status: "complete", summary: "done" });
  }) as FauxResponseStep;
}

describe("faux spawnAgent — skills: advertising (pi-parity)", () => {
  it("resolves the on-disk skill", () => {
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("docs-x");
    expect(skills[0].description).toContain("widget service");
  });

  it("advertises name/description/location — not the SKILL.md body", async () => {
    const seen = { prompt: "" };

    const { result } = await spawnFaux({
      agent: { skills: ["docs-x"], tools: [] },
      skills,
      responses: [captureSystemPrompt(seen)],
    });

    expect(result.success).toBe(true);
    expect(seen.prompt).toContain("<available_skills>");
    expect(seen.prompt).toContain("docs-x");
    expect(seen.prompt).toContain("<location>");
    expect(seen.prompt).toContain(skillMdPath);
    // Progressive disclosure: the body is NOT dumped into the prompt.
    expect(seen.prompt).not.toContain("SENTINEL_SKILL_BODY_XYZ");
  });

  it("advertises nothing when no skills are declared", async () => {
    const seen = { prompt: "" };

    await spawnFaux({
      agent: { tools: [] },
      responses: [captureSystemPrompt(seen)],
    });

    expect(seen.prompt).not.toContain("<available_skills>");
  });

  it("auto-grants read and whitelists the skill dir under a restrictive sandbox", async () => {
    // Agent declares NO read tool and a read sandbox that EXCLUDES the skill
    // dir. The engine must auto-add `read` and widen `access.read` to the skill
    // dir so the agent can load the advertised SKILL.md.
    const { result } = await spawnFaux({
      agent: {
        skills: ["docs-x"],
        tools: [],
        access: { read: ["/nonexistent/**"] },
      },
      skills,
      responses: scriptToolThenFinish(
        "read",
        { path: skillMdPath },
        { status: "complete", summary: "read the skill" },
      ),
    });

    expect(result.success).toBe(true);
    const read = result.toolCalls.find((t) => t.toolName === "read");
    expect(read).toBeDefined();
    expect(read!.isError).toBe(false);
    expect(read!.output).toContain("SENTINEL_SKILL_BODY_XYZ");
  });

  it("reads a topic file via read (progressive disclosure)", async () => {
    const topicPath = join(skillDir, "references", "api.md");
    const { result } = await spawnFaux({
      agent: { skills: ["docs-x"], tools: [] },
      skills,
      responses: scriptToolThenFinish(
        "read",
        { path: topicPath },
        { status: "complete", summary: "read topic" },
      ),
    });

    const read = result.toolCalls.find((t) => t.toolName === "read");
    expect(read!.isError).toBe(false);
    expect(read!.output).toContain("TOPIC_FILE_BODY");
  });

  it("still blocks reads outside the skill dir under a restrictive sandbox", async () => {
    // The skill-dir whitelist must NOT open the whole filesystem: a read of an
    // unrelated path stays denied, and the first denial lists the allowed paths.
    const { result } = await spawnFaux({
      agent: {
        skills: ["docs-x"],
        tools: [],
        access: { read: ["/nonexistent/**"] },
      },
      skills,
      responses: scriptToolThenFinish(
        "read",
        { path: "/etc/passwd" },
        { status: "complete", summary: "tried escape" },
      ),
    });

    const read = result.toolCalls.find((t) => t.toolName === "read");
    expect(read!.isError).toBe(true);
    expect(String(read!.output)).toContain("Allowed read paths");
  });
});
