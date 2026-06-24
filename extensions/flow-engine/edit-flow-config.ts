// ---------------------------------------------------------------------------
// Edit-flow config — read the opt-in flag that activates the edit-flow tools.
//
// The `flow_agents` and `flow_write` tools are inactive by default. They are
// activated for a session when settings enable them via the `flows.editFlow`
// boolean (a top-level `flowsEditFlow` boolean is also accepted).
//
// Sources (project overrides global):
//   - global:  ~/<CONFIG_DIR>/agent/settings.json   (always honored)
//   - project: <projectRoot>/<CONFIG_DIR>/settings.json  (trusted projects only)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = ".pi";

/** Extract the boolean edit-flow flag from a parsed settings object. */
export function readEditFlowFlag(settings: unknown): boolean | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const s = settings as Record<string, unknown>;
  const flows = s.flows;
  if (flows && typeof flows === "object" && "editFlow" in (flows as Record<string, unknown>)) {
    const v = (flows as Record<string, unknown>).editFlow;
    if (typeof v === "boolean") return v;
  }
  if (typeof s.flowsEditFlow === "boolean") return s.flowsEditFlow;
  return undefined;
}

function readSettingsFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Whether flow/agent edit-flow tools should be active for this session.
 *
 * Resolution: project setting (when trusted) overrides global setting; default
 * is `false` when neither sets the flag.
 */
export function isEditFlowEnabled(
  projectRoot: string,
  opts: { projectTrusted: boolean; home?: string } = { projectTrusted: false },
): boolean {
  const home = opts.home ?? homedir();
  const globalFlag = readEditFlowFlag(readSettingsFile(join(home, CONFIG_DIR, "agent", "settings.json")));
  const projectFlag = opts.projectTrusted
    ? readEditFlowFlag(readSettingsFile(join(projectRoot, CONFIG_DIR, "settings.json")))
    : undefined;

  if (projectFlag !== undefined) return projectFlag;
  if (globalFlag !== undefined) return globalFlag;
  return false;
}
