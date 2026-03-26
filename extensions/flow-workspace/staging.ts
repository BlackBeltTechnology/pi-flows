// ---------------------------------------------------------------------------
// Staging Directory — Temporary file isolation for flow architect sessions
//
// All architect-written files go to .pi/flows/.staging/ during design.
// Files are promoted to final locations on Save, wiped on Cancel/Replan.
// Orphaned staging dirs are cleaned up on pi startup.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export const STAGING_DIR = ".pi/flows/.staging";
export const STAGING_AGENTS = ".pi/flows/.staging/agents";
export const STAGING_FLOWS = ".pi/flows/.staging/flows";

/**
 * Create the staging directory structure.
 */
export function createStagingDir(projectRoot: string): void {
  mkdirSync(join(projectRoot, STAGING_AGENTS), { recursive: true });
  mkdirSync(join(projectRoot, STAGING_FLOWS), { recursive: true });
}

/**
 * Wipe the entire staging directory.
 */
export function wipeStagingDir(projectRoot: string): void {
  const dir = join(projectRoot, STAGING_DIR);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check if a staging directory exists (for crash recovery).
 */
export function hasStagingDir(projectRoot: string): boolean {
  return existsSync(join(projectRoot, STAGING_DIR));
}

/**
 * Promote staged files to their final locations and wipe staging.
 *
 * - Agents: .staging/agents/*.md → .pi/flows/agents/
 * - Flow:   .staging/flows/*.flow.md → .pi/flows/flows/custom/<flowName>.flow.md
 *
 * Returns the final flow file path, or null if no flow was staged.
 */
export function promoteStagingToFinal(
  projectRoot: string,
  flowName: string,
): string | null {
  const stagingAgents = join(projectRoot, STAGING_AGENTS);
  const stagingFlows = join(projectRoot, STAGING_FLOWS);
  const finalAgents = join(projectRoot, ".pi", "flows", "agents");
  const finalFlows = join(projectRoot, ".pi", "flows", "flows", "custom");

  // Ensure final directories exist
  mkdirSync(finalAgents, { recursive: true });
  mkdirSync(finalFlows, { recursive: true });

  // Copy agents
  if (existsSync(stagingAgents)) {
    for (const file of readdirSync(stagingAgents)) {
      if (file.endsWith(".md")) {
        copyFileSync(join(stagingAgents, file), join(finalAgents, file));
      }
    }
  }

  // Copy flow file — use the provided flowName for the final filename
  let finalFlowPath: string | null = null;
  if (existsSync(stagingFlows)) {
    const flowFiles = readdirSync(stagingFlows).filter(f => f.endsWith(".flow.md"));
    if (flowFiles.length > 0) {
      // Take the first (should only be one)
      const srcFlow = join(stagingFlows, flowFiles[0]);
      finalFlowPath = join(finalFlows, `${flowName}.flow.md`);
      copyFileSync(srcFlow, finalFlowPath);
    }
  }

  // Wipe staging
  wipeStagingDir(projectRoot);

  return finalFlowPath;
}
