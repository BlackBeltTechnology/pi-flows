import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill-directory resolution shared by the flow engine.
 *
 * Skills are advertised to agents the pi way — name + description + location in
 * the system prompt (via `formatSkillsForPrompt`) — and agents load `SKILL.md`
 * and its topic files on demand with the standard `read` tool (auto-granted, and
 * the skill dirs whitelisted into any `access.read` sandbox, by `spawnAgent`).
 * There is no bespoke `skill_read` tool; these helpers only locate a skill's
 * directory so pi's `loadSkillsFromDir` can resolve it.
 */

const extraSkillsDirs: string[] = [];

/** Register an extra skills root (e.g. contributed by a downstream package). */
export function registerExtraSkillsDir(dir: string): void {
  if (!extraSkillsDirs.includes(dir)) extraSkillsDirs.push(dir);
}

/** Locate the directory containing `<skillName>/SKILL.md`, or null if absent. */
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
