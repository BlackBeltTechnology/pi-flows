/**
 * Autonomous Mode Extension (pi-flows)
 *
 * Tracks the global "autonomous" toggle used by the flow engine to decide
 * whether fork steps auto-decide via the configured decision agent vs.
 * prompt the user. Persisted to `~/.pi/agent/providers.json#autonomousMode`.
 *
 * Previously lived inside `role-manager.ts` — split out so role management
 * can move to pi-agent-dashboard without dragging this unrelated state
 * along.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "providers.json");

let autonomousModeEnabled = true;

function loadFullConfig(): Record<string, unknown> {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      // Fall through to empty
    }
  }
  return {};
}

function saveAutonomousMode(enabled: boolean): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  // Preserve all other fields (roles, providers, etc.) — only touch our key.
  const full = loadFullConfig();
  full.autonomousMode = enabled;
  writeFileSync(CONFIG_PATH, JSON.stringify(full, null, 2));
}

export function isAutonomousMode(): boolean {
  return autonomousModeEnabled;
}

export function setAutonomousMode(enabled: boolean): void {
  autonomousModeEnabled = enabled;
  saveAutonomousMode(enabled);
}

export function activate(_pi: ExtensionAPI): void {
  // Bootstrap in-memory state from disk so `isAutonomousMode()` reflects
  // persisted state from the moment activation finishes.
  const raw = loadFullConfig();
  autonomousModeEnabled = (raw.autonomousMode as boolean | undefined) ?? true;
}
