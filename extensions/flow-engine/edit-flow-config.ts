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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Persist `flows.editFlow` to the PROJECT `.pi/settings.json` (never the global
 * file). Read-merge-write: all other keys are preserved; the file (and `.pi/`)
 * is created when absent. The edit-mode toggle owns this write.
 */
export function setEditFlowFlag(projectRoot: string, enabled: boolean): void {
  const path = join(projectRoot, CONFIG_DIR, "settings.json");
  const existing = readSettingsFile(path);
  const settings: Record<string, unknown> =
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  const flows =
    settings.flows && typeof settings.flows === "object"
      ? { ...(settings.flows as Record<string, unknown>) }
      : {};
  flows.editFlow = enabled;
  settings.flows = flows;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/** Parse an edit-mode command argument. `on`→true, `off`→false, anything else→null. */
export function parseEditModeArg(arg: string | undefined): boolean | null {
  const a = (arg ?? "").trim().toLowerCase();
  if (a === "on" || a === "true" || a === "enable") return true;
  if (a === "off" || a === "false" || a === "disable") return false;
  return null;
}
