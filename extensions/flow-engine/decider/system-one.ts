// ---------------------------------------------------------------------------
// `system-one` entry — calls predict() from @blackbelt-technology/pi-system-one.
// The library is imported lazily, only when a chain contains `system-one`, so
// flows without it never load it or touch ~/.pi/agent/system-one/.
// See change: classifier-decisions (D5, D12).
// ---------------------------------------------------------------------------

import type { LlmCaller, PredictResult, SystemOneConfig } from "@blackbelt-technology/pi-system-one";
import type { ClassifierEntry, EntryResult } from "./types.js";

/** The slice of the library pi-flows uses. */
export interface SystemOneLib {
  predict(req: any): Promise<PredictResult>;
  loadConfig(opts?: any): SystemOneConfig;
  isLoopbackHost?(hostname: string): boolean;
}

export const loadSystemOneLib = async (): Promise<SystemOneLib> =>
  (await import("@blackbelt-technology/pi-system-one")) as unknown as SystemOneLib;

const QUESTION_KEY = "decision";

/** `pi-flows:<flow>:<step>`, matching the library's CONSUMER_ID. */
export function systemOneConsumerId(flowName: string, stepId: string): string {
  return `pi-flows:${flowName}:${stepId}`.toLowerCase().replace(/[^a-z0-9:._-]/g, "-").slice(0, 128);
}

export interface SystemOneEntryOptions {
  flowName: string;
  stepId: string;
  branchCount: number;
  cwd: string;
  projectTrusted: boolean;
  llmCaller?: LlmCaller;
  loadLib?: () => Promise<SystemOneLib>;
}

export function createSystemOneEntry(o: SystemOneEntryOptions): ClassifierEntry {
  const consumerId = systemOneConsumerId(o.flowName, o.stepId);
  return async (q, signal): Promise<EntryResult> => {
    let lib: SystemOneLib;
    try {
      lib = await (o.loadLib ?? loadSystemOneLib)();
    } catch (err) {
      return { ok: false, outcome: "error", reason: `pi-system-one could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
    }
    const project = { cwd: o.cwd, trusted: o.projectTrusted };
    const res = await lib.predict({
      consumer: {
        id: consumerId,
        label: `${o.flowName} › ${o.stepId}`,
        failurePolicy: "fail-open",
        requires: { primitives: ["choice"], maxOptions: o.branchCount },
      },
      state: JSON.stringify(q.state),
      questions: { [QUESTION_KEY]: q.question },
      signal,
      project,
      llmCaller: o.llmCaller,
    });

    if (!res.ok) {
      const tried = res.attempts.map((a) => `${a.backendId}: ${a.outcome}`).join("; ");
      const outcome = res.reason === "no-backend" || res.reason === "off-machine" || res.reason === "timeout" ? res.reason : "error";
      return { ok: false, outcome, reason: `System One: ${res.reason}${tried ? ` (${tried})` : ""}` };
    }
    const ans = res.answers[QUESTION_KEY] as { choice?: string; probabilities?: Record<string, number>; confidence?: number } | undefined;
    if (!ans || typeof ans.choice !== "string") {
      return { ok: false, outcome: "error", reason: "System One returned no choice answer" };
    }
    let calibrated = false;
    try {
      calibrated = Object.hasOwn(lib.loadConfig({ project }).calibration ?? {}, `${res.backendId}::${consumerId}`);
    } catch {
      calibrated = false;
    }
    return {
      ok: true,
      calibrated,
      answer: {
        label: ans.choice,
        confidence: typeof ans.confidence === "number" ? ans.confidence : 0,
        probabilities: ans.probabilities,
        mode: res.mode,
        model: res.model,
        backendId: res.backendId,
      },
    };
  };
}
