// ---------------------------------------------------------------------------
// Flow Engine -- Discovery
//
// Discovers agents and flows from package and registered directories.
// Discovery: extra packages → pi-flows package → project-local.
// ---------------------------------------------------------------------------

import type { AgentConfig, FlowConfig } from "./types.js";
import { parseAgentFile } from "./agent-parser.js";
import { parseFlowFile } from "./flow-parser.js";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Public types ---------------------------------------------------------

export interface DiscoveryResult {
  agents: Map<string, AgentConfig>;
  flows: Map<string, FlowConfig>;
}

// ---- Public API -----------------------------------------------------------

// Discover all agents and flows from multiple tiers:
// extra package dirs -> pi-flows package -> project-local (.pi/flows/)
export function discoverAll(
  packageRoot: string,
  projectRoot: string,
  extraAgentsDirs?: string[],
  extraFlowsDirs?: string[],
): DiscoveryResult {
  const agents = new Map<string, AgentConfig>();
  const flows = new Map<string, FlowConfig>();

  // --- Agents ---

  // Extra package agents (registered by dependent packages via events)
  if (extraAgentsDirs) {
    for (const dir of extraAgentsDirs) {
      for (const agent of discoverAgentsInDir(dir)) {
        agents.set(agent.name, agent);
      }
    }
  }

  // pi-flows package agents: agents/*.md
  const packageAgentsDir = join(packageRoot, "agents");
  for (const agent of discoverAgentsInDir(packageAgentsDir)) {
    agents.set(agent.name, agent);
  }

  // --- Flows ---

  // Extra package flows (registered by dependent packages via events)
  if (extraFlowsDirs) {
    for (const dir of extraFlowsDirs) {
      for (const flow of discoverFlowsInDir(dir)) {
        flows.set(flow.name, flow);
      }
    }
  }

  // pi-flows package flows: flows/*.flow.md (recursive)
  const packageFlowsDir = join(packageRoot, "flows");
  for (const flow of discoverFlowsInDir(packageFlowsDir)) {
    flows.set(flow.name, flow);
  }

  // --- Project-local (highest priority — overrides package on name collision) ---

  const localAgentsDir = join(projectRoot, ".pi", "flows", "agents");
  for (const agent of discoverAgentsInDir(localAgentsDir)) {
    agents.set(agent.name, agent);
  }

  const localFlowsDir = join(projectRoot, ".pi", "flows", "flows");
  for (const flow of discoverFlowsInDir(localFlowsDir)) {
    flows.set(flow.name, flow);
  }

  return { agents, flows };
}

/**
 * Resolve the package root directory from an `import.meta.url` value.
 *
 * Assumes the calling module lives two directories below the package root:
 *   `file:///home/.../extensions/flow-engine/discovery.ts`
 *   -> `dirname` twice -> package root
 */
export function resolvePackageRoot(importMetaUrl: string): string {
  const __filename = fileURLToPath(importMetaUrl);
  return join(dirname(__filename), "..", "..");
}

// ---- Agent discovery helpers ----------------------------------------------

/**
 * Scan a directory for agent `.md` files (excluding .flow.md).
 */
function discoverAgentsInDir(dir: string): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const agents: AgentConfig[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Only consider .md files, but exclude .flow.md and .chain.md files
    if (!entry.endsWith(".md") || entry.endsWith(".flow.md") || entry.endsWith(".chain.md")) continue;

    const filePath = join(dir, entry);

    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }

    try {
      const config = parseAgentFile(filePath);
      agents.push(config);
    } catch (err) {
      console.warn(
        `[discovery] Skipping unparseable agent file: ${filePath}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return agents;
}

// ---- Flow discovery helpers -----------------------------------------------

/**
 * Recursively scan a directory for `.flow.md` files.
 * Subfolder structure determines the flow name prefix:
 *   `flows/judo/research.flow.md` -> name = `judo:research`
 */
function discoverFlowsInDir(flowsRoot: string): FlowConfig[] {
  if (!existsSync(flowsRoot)) return [];

  const flows: FlowConfig[] = [];
  walkFlowFiles(flowsRoot, flowsRoot, flows);
  return flows;
}

/**
 * Recursively walk `dir`, collecting `.flow.md` files.
 */
function walkFlowFiles(
  dir: string,
  flowsRoot: string,
  results: FlowConfig[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walkFlowFiles(fullPath, flowsRoot, results);
      continue;
    }

    if (!entry.endsWith(".flow.md")) continue;

    try {
      const config = parseFlowFile(fullPath);

      // Compute the flow name from the subfolder structure.
      // E.g., flows/judo/research.flow.md -> relative = "judo/research.flow.md"
      //   -> baseName = "research", prefix = "judo" -> name = "judo:research"
      const relativePath = relative(flowsRoot, fullPath);
      const relDir = dirname(relativePath);
      const baseName = basename(entry, ".flow.md");

      // Enforce single-subfolder depth: skip files nested 2+ levels deep
      if (relDir !== "." && relDir.includes("/")) {
        console.warn(
          `[discovery] Skipping flow file with excessive nesting (max 1 subfolder): ${fullPath}`,
        );
        continue;
      }

      const flowName =
        relDir === "." ? baseName : `${relDir.replace(/[\\/]/g, ":")}:${baseName}`;

      // Override the parsed name with the filesystem-derived name
      config.name = flowName;

      results.push(config);
    } catch (err) {
      console.warn(
        `[discovery] Skipping unparseable flow file: ${fullPath}`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
