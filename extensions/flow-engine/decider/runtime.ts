// ---------------------------------------------------------------------------
// Entry runner — maps chain entry names to adapters for one decision.
// See change: classifier-decisions (D2, D7).
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParentModelSnapshot } from "../model-roles.js";
import { createLlmCaller } from "./llm-caller.js";
import { createPiAiEntry } from "./pi-ai.js";
import { createSystemOneEntry, loadSystemOneLib } from "./system-one.js";
import type { ClassifierEntry, DecisionQuestion, EntryResult } from "./types.js";

/** Engine-side inputs the adapters need (a subset of FlowRunOptions). */
export interface DeciderEnv {
  pi: any;
  cwd: string;
  modelRegistry?: any;
  modelRuntime?: any;
  parentModel?: ParentModelSnapshot;
  modelFallback?: "session" | "error";
  projectTrusted?: boolean;
  /** Test seam: replaces the adapter for an entry name (`system-one` or `provider/model`). */
  entryOverrides?: Record<string, ClassifierEntry>;
}

const LOOPBACK = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/i;
const localLoopback = (h: string): boolean => LOOPBACK.test(h);

interface PrivacyGate {
  blockOffMachine: boolean;
  isLoopbackHost: (hostname: string) => boolean;
}

const gates = new WeakMap<object, Promise<PrivacyGate>>();

/**
 * System One's `allowOffMachine: false` also blocks hosted pi-ai classifiers.
 * Without a System One configuration file there is no gate. Read once per run.
 */
function privacyGate(env: DeciderEnv): Promise<PrivacyGate> {
  const key = env.pi ?? env;
  let p = gates.get(key);
  if (!p) {
    p = (async (): Promise<PrivacyGate> => {
      if (!existsSync(join(homedir(), ".pi", "agent", "system-one.json"))) {
        return { blockOffMachine: false, isLoopbackHost: localLoopback };
      }
      try {
        const lib = await loadSystemOneLib();
        const cfg = lib.loadConfig({ project: { cwd: env.cwd, trusted: env.projectTrusted === true } });
        return { blockOffMachine: cfg.allowOffMachine === false, isLoopbackHost: lib.isLoopbackHost ?? localLoopback };
      } catch {
        return { blockOffMachine: false, isLoopbackHost: localLoopback };
      }
    })();
    gates.set(key, p);
  }
  return p;
}

export interface EntryRunnerArgs {
  env: DeciderEnv;
  flowName: string;
  stepId: string;
  branchCount: number;
  question: DecisionQuestion;
  /** Runs the decision agent (the `agent` entry). */
  agentEntry: () => Promise<EntryResult>;
}

export function makeEntryRunner(a: EntryRunnerArgs): (entry: string, signal: AbortSignal) => Promise<EntryResult> {
  const { env } = a;
  return async (entry, signal) => {
    if (entry === "agent") return a.agentEntry();
    const override = env.entryOverrides?.[entry];
    if (override) return override(a.question, signal);

    if (entry === "system-one") {
      const llmCaller = createLlmCaller({
        pi: env.pi,
        registry: env.modelRegistry,
        parentModel: env.parentModel,
        modelFallback: env.modelFallback,
        complete: env.modelRuntime?.complete
          ? (m, c, o) => env.modelRuntime.complete(m, c, o)
          : undefined,
      });
      return createSystemOneEntry({
        flowName: a.flowName,
        stepId: a.stepId,
        branchCount: a.branchCount,
        cwd: env.cwd,
        projectTrusted: env.projectTrusted === true,
        llmCaller,
      })(a.question, signal);
    }

    const gate = await privacyGate(env);
    return createPiAiEntry({
      ref: entry,
      registry: env.modelRegistry,
      blockOffMachine: gate.blockOffMachine,
      isLoopbackHost: gate.isLoopbackHost,
    })(a.question, signal);
  };
}
