// ---------------------------------------------------------------------------
// Flows settings — `flows.modelFallback` and `flows.decisionAgent`.
//
// Same sources as edit-flow-config.ts (project overrides global, no trust gate):
//   - global:  ~/.pi/agent/settings.json
//   - project: <projectRoot>/.pi/settings.json
// Read once at flow start and frozen for the run.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENTRY_FORMS, TRUST_MODES, isValidEntry, parseDeciderSpec } from "./decider/chain.js";
import type { DeciderSpec } from "./types.js";

export type ModelFallbackMode = "session" | "error";

export interface FlowsSettings {
  modelFallback: ModelFallbackMode;
  decisionAgent: string | undefined;
  /** `flows.decider` default chain for decision steps (undefined → [agent]). */
  decider: DeciderSpec | undefined;
  warnings: string[];
}

function readFlowsBlock(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const flows = parsed?.flows;
    return flows && typeof flows === "object" ? (flows as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readFlowsSettings(projectRoot: string, opts: { home?: string } = {}): FlowsSettings {
  const home = opts.home ?? homedir();
  const global = readFlowsBlock(join(home, ".pi", "agent", "settings.json"));
  const project = readFlowsBlock(join(projectRoot, ".pi", "settings.json"));
  const warnings: string[] = [];

  const rawFallback = "modelFallback" in project ? project.modelFallback : global.modelFallback;
  let modelFallback: ModelFallbackMode = "session";
  if (rawFallback === "session" || rawFallback === "error") modelFallback = rawFallback;
  else if (rawFallback !== undefined) {
    warnings.push(`Invalid flows.modelFallback "${String(rawFallback)}" (use "session" or "error"); using "session".`);
  }

  const rawAgent = project.decisionAgent !== undefined ? project.decisionAgent : global.decisionAgent;
  const decisionAgent = typeof rawAgent === "string" && rawAgent.trim() ? rawAgent.trim() : undefined;

  let decider: DeciderSpec | undefined;
  const rawDecider = "decider" in project ? project.decider : global.decider;
  if (rawDecider !== undefined) {
    try {
      const spec = parseDeciderSpec(rawDecider);
      const bad = (spec.entries ?? []).filter((e) => !isValidEntry(e));
      if (bad.length) throw new Error(`unknown entry "${bad[0]}" (use ${ENTRY_FORMS})`);
      if (spec.trust !== undefined && !TRUST_MODES.includes(spec.trust)) throw new Error(`invalid trust "${spec.trust}"`);
      if (spec.minConfidence !== undefined && !(spec.minConfidence >= 0 && spec.minConfidence <= 1)) throw new Error("min_confidence must be between 0 and 1");
      decider = spec;
    } catch (err) {
      warnings.push(`Invalid flows.decider: ${err instanceof Error ? err.message : String(err)}; using the default [agent].`);
    }
  }

  return { modelFallback, decisionAgent, decider, warnings };
}
