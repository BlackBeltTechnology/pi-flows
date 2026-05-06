// ---------------------------------------------------------------------------
// Project Root Resolution
//
// Finds the root of the current project by walking up from process.cwd()
// looking for a .git directory. Falls back to ~/.pi if no git repo is found,
// so flows/agents are stored globally when pi is used outside a project.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the project root for storing flows and agents.
 *
 * - If process.cwd() (or any ancestor) contains a .git directory, that is
 *   the project root and flows live in <project>/.pi/flows/.
 * - If no git repo is found, fall back to ~/.pi so flows are stored globally.
 */
export function resolveProjectRoot(): string {
  let dir = process.cwd();

  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return join(homedir(), ".pi");
}
