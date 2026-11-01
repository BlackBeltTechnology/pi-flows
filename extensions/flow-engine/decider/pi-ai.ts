// ---------------------------------------------------------------------------
// `provider/model` entry — a pi-ai classifier via modelRegistry.classify().
// See change: classifier-decisions (D3, D7).
// ---------------------------------------------------------------------------

import type { ClassifierEntry, EntryResult } from "./types.js";

export interface PiAiEntryOptions {
  /** `provider/model`, e.g. `typesafe/jev-latest`. */
  ref: string;
  /** pi's session ModelRegistry (`ctx.modelRegistry`). */
  registry: any;
  /** System One `allowOffMachine: false` → refuse non-loopback classifiers. */
  blockOffMachine: boolean;
  isLoopbackHost: (hostname: string) => boolean;
}

export function createPiAiEntry(o: PiAiEntryOptions): ClassifierEntry {
  const slash = o.ref.indexOf("/");
  const provider = o.ref.slice(0, slash);
  const modelId = o.ref.slice(slash + 1);
  return async (q, signal): Promise<EntryResult> => {
    let model: any;
    try {
      model = o.registry?.getModelOfType?.("classifier", provider, modelId);
    } catch {
      model = undefined;
    }
    if (!model) {
      return { ok: false, outcome: "error", reason: `"${o.ref}" is not a known classifier model` };
    }
    let local = false;
    try {
      local = o.isLoopbackHost(new URL(String(model.baseUrl)).hostname);
    } catch {
      local = false;
    }
    if (o.blockOffMachine && !local) {
      return { ok: false, outcome: "off-machine", reason: `${o.ref} runs off this machine and System One has allowOffMachine: false` };
    }
    // Local servers may be keyless; only hosted providers need a credential.
    if (!local) {
      let hasAuth = true;
      try { hasAuth = o.registry.hasConfiguredAuth(model) !== false; } catch { hasAuth = true; }
      if (!hasAuth) return { ok: false, outcome: "credentials", reason: `no credential configured for provider "${provider}"` };
    }
    const res = await o.registry.classify(model, { state: q.state, questions: { decision: q.question } }, { signal });
    if (res.stopReason === "aborted") return { ok: false, outcome: "aborted", reason: res.errorMessage };
    if (res.stopReason === "error") {
      return { ok: false, outcome: "error", reason: res.errorMessage ?? "classifier error" };
    }
    const ans = res.answers?.decision;
    if (!ans || ans.type !== "choice" || typeof ans.choice !== "string") {
      return { ok: false, outcome: "error", reason: "classifier returned no choice answer" };
    }
    return {
      ok: true,
      answer: {
        label: ans.choice,
        confidence: ans.confidence,
        probabilities: ans.probabilities,
        model: o.ref,
        ...(res.usage ? { usage: res.usage } : {}),
      },
    };
  };
}
