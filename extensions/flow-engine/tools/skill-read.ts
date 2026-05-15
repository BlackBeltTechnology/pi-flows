import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const extraSkillsDirs: string[] = [];

export function registerExtraSkillsDir(dir: string): void {
  if (!extraSkillsDirs.includes(dir)) extraSkillsDirs.push(dir);
}

export function findSkillDir(packageRoot: string, skillName: string): string | null {
  // Check extra dirs first (dependent packages like judo)
  for (const dir of extraSkillsDirs) {
    const candidate = join(dir, skillName, "SKILL.md");
    if (existsSync(candidate)) return join(dir, skillName);
  }
  // Then check pi-flows own skills dir
  const candidate = join(packageRoot, "skills", skillName, "SKILL.md");
  if (existsSync(candidate)) return join(packageRoot, "skills", skillName);
  return null;
}

export function registerSkillReadTool(pi: ExtensionAPI, packageRoot: string): void {
  pi.registerTool({
    name: "skill_read",
    description: "Read a detail file from a skill. Skills provide framework documentation. Use to access detailed reference docs listed in a skill's SKILL.md.",
    parameters: Type.Object({
      skill: Type.String({ description: "Skill name (e.g., 'judo-backend-docs')" }),
      file: Type.String({ description: "Detail file name (e.g., 'custom-operations.md')" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const skillDir = findSkillDir(packageRoot, params.skill);

      if (!skillDir) {
        return { content: [{ type: "text", text: `Error: Skill '${params.skill}' not found` }], details: {} };
      }

      const skillMdPath = join(skillDir, "SKILL.md");

      // Validate file is listed in SKILL.md
      const skillMd = readFileSync(skillMdPath, "utf-8");
      if (!skillMd.includes(params.file)) {
        return { content: [{ type: "text", text: `Error: File '${params.file}' is not listed in ${params.skill}/SKILL.md. Check 'Available Reference Files' section.` }], details: {} };
      }

      const filePath = join(skillDir, params.file);
      if (!existsSync(filePath)) {
        return { content: [{ type: "text", text: `Error: File '${params.file}' listed in SKILL.md but not found at ${filePath}` }], details: {} };
      }

      const content = readFileSync(filePath, "utf-8");
      return {
        content: [{ type: "text", text: content }],
        details: {},
      };
    },
  });
}
