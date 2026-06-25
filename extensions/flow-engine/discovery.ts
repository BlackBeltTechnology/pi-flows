// ---------------------------------------------------------------------------
// Flow Engine -- Discovery
//
// Discovers agents and flows from package and registered directories.
// Discovery: extra packages → pi-flows package → project-local.
// ---------------------------------------------------------------------------

import type { AgentConfig, FlowConfig } from "./types.js";
import { parseAgentFile } from "./agent-parser.js";
import { parseFlowYamlFile } from "./flow-parser-yaml.js";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Public types ---------------------------------------------------------

export interface DiscoveryResult {
  agents: Map<string, AgentConfig>;
  flows: Map<string, FlowConfig>;
  warnings: string[];
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
  const warnings: string[] = [];

  // --- Agents ---

  // Extra package agents (registered by dependent packages via events)
  if (extraAgentsDirs) {
    for (const dir of extraAgentsDirs) {
      for (const agent of discoverAgentsInDir(dir, warnings)) {
        agents.set(agent.name, agent);
      }
    }
  }

  // pi-flows package agents: agents/*.md
  const packageAgentsDir = join(packageRoot, "agents");
  for (const agent of discoverAgentsInDir(packageAgentsDir, warnings)) {
    agents.set(agent.name, agent);
  }

  // --- Flows ---

  // Extra package flows (registered by dependent packages via events)
  if (extraFlowsDirs) {
    for (const dir of extraFlowsDirs) {
      for (const flow of discoverFlowsInDir(dir, warnings)) {
        flows.set(flow.name, flow);
      }
    }
  }

  // pi-flows package flows: flows/*.yaml (recursive)
  const packageFlowsDir = join(packageRoot, "flows");
  for (const flow of discoverFlowsInDir(packageFlowsDir, warnings)) {
    flows.set(flow.name, flow);
  }

  // --- Project-local (highest priority — overrides package on name collision) ---

  const localAgentsDir = join(projectRoot, ".pi", "flows", "agents");
  for (const agent of discoverAgentsInDir(localAgentsDir, warnings)) {
    agents.set(agent.name, agent);
  }

  const localFlowsDir = join(projectRoot, ".pi", "flows", "flows");
  for (const flow of discoverFlowsInDir(localFlowsDir, warnings)) {
    flows.set(flow.name, flow);
  }

  return { agents, flows, warnings };
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
 * Scan a directory for agent `.md` files (excluding non-agent files).
 */
function discoverAgentsInDir(dir: string, warnings: string[]): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const agents: AgentConfig[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Only consider .md files, exclude .chain.md and skip .yaml files entirely
    if (!entry.endsWith(".md") || entry.endsWith(".chain.md")) continue;

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
      warnings.push(
        `[discovery] Skipping unparseable agent file: ${filePath} ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return agents;
}

// ---- Flow discovery helpers -----------------------------------------------

/**
 * Recursively scan for bundled flow directories. Each flow is a directory
 * containing a `flow.yaml`; its command id is the flow directory's path
 * relative to `flowsRoot`, slashes joined by `:`:
 *   `flows/judo/research/flow.yaml` -> name = `judo:research`
 * Loose `<name>.yaml` files (the old flat layout) are NOT discovered.
 */
function discoverFlowsInDir(flowsRoot: string, warnings: string[]): FlowConfig[] {
  if (!existsSync(flowsRoot)) return [];

  const flows: FlowConfig[] = [];
  walkFlowFiles(flowsRoot, flowsRoot, flows, warnings);
  return flows;
}

/**
 * Recursively walk `dir`, collecting `.yaml` flow files.
 */
function walkFlowFiles(
  dir: string,
  flowsRoot: string,
  results: FlowConfig[],
  warnings: string[],
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

    // Bundled layout: flows are directories containing `flow.yaml`. Loose files
    // (the old flat `<name>.yaml`) are ignored — clean break, no fallback.
    if (!stat.isDirectory()) continue;

    const flowYamlPath = join(fullPath, "flow.yaml");
    if (existsSync(flowYamlPath)) {
      try {
        const config = parseFlowYamlFile(flowYamlPath); // sets source = flowYamlPath
        // Command id = flow directory's path relative to flowsRoot, slashes -> ":".
        // E.g. <flowsRoot>/judo/research -> "judo:research".
        config.name = relative(flowsRoot, fullPath).replace(/[\\/]/g, ":");
        results.push(config);
      } catch (err) {
        warnings.push(
          `[discovery] Skipping unparseable flow file: ${flowYamlPath} ${err instanceof Error ? err.message : err}`,
        );
      }
      // A flow directory's contents are handlers — do not recurse into it.
      continue;
    }

    // Namespace directory: recurse to find nested flow directories.
    walkFlowFiles(fullPath, flowsRoot, results, warnings);
  }
}
