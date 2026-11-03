// ---------------------------------------------------------------------------
// Decider chain — resolution + execution. See change: classifier-decisions (D1, D8, D9).
// ---------------------------------------------------------------------------

import type { DeciderSpec, TrustMode } from "../types.js";
import type { DecisionAttempt, DecisionOutcome, EntryResult, TrustPolicy } from "./types.js";
import { isTrusted } from "./trust.js";

export const DEFAULT_MIN_CONFIDENCE = 0.75;
export const DECIDER_TIMEOUT_MS = 15_000;
export const TRUST_MODES: readonly TrustMode[] = ["auto", "calibrated", "confidence"];
export const ENTRY_FORMS = "`system-one`, `agent`, or a classifier model ref `provider/model`";

/** `system-one` | `agent` | `provider/model`. */
export function isValidEntry(entry: string): boolean {
  return entry === "system-one" || entry === "agent" || /^[^/\s]+\/\S+$/.test(entry);
}

export function isClassifierRefEntry(entry: string): boolean {
  return entry !== "agent" && entry !== "system-one";
}

/**
 * Parse a `decider:` value (YAML or `flows.decider` setting): a list of entries,
 * or `{ chain, trust, min_confidence }`. Semantic checks live in the validator.
 */
export function parseDeciderSpec(raw: unknown): DeciderSpec {
  if (Array.isArray(raw)) return { entries: raw.map(String) };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const spec: DeciderSpec = {};
    if (o.chain !== undefined) {
      if (!Array.isArray(o.chain)) throw new Error('decider "chain" must be a list');
      spec.entries = o.chain.map(String);
    }
    if (o.trust !== undefined) spec.trust = String(o.trust) as TrustMode;
    const mc = o.min_confidence ?? o.minConfidence;
    if (mc !== undefined) spec.minConfidence = Number(mc);
    return spec;
  }
  throw new Error('"decider" must be a list of entries or an object { chain, trust, min_confidence }');
}

export interface ResolvedDecider extends TrustPolicy {
  entries: string[];
}

/** step → flow → `flows.decider` → `[agent]`; trust fields resolve one by one. */
export function resolveDecider(
  step: DeciderSpec | undefined,
  flow: DeciderSpec | undefined,
  settings: DeciderSpec | undefined,
): ResolvedDecider {
  const layers = [step, flow, settings];
  const pick = <K extends keyof DeciderSpec>(k: K): DeciderSpec[K] | undefined => {
    for (const l of layers) if (l && l[k] !== undefined) return l[k];
    return undefined;
  };
  return {
    entries: pick("entries") ?? ["agent"],
    trust: pick("trust") ?? "auto",
    minConfidence: pick("minConfidence") ?? DEFAULT_MIN_CONFIDENCE,
  };
}

export interface DecideRequest extends TrustPolicy {
  entries: string[];
  /** Valid labels (branch keys / fork options). */
  labels: string[];
  run: (entry: string, signal: AbortSignal) => Promise<EntryResult>;
  signal?: AbortSignal;
  /**
   * Per pi-ai classifier entry. `agent` and `system-one` are exempt (System One applies
   * its own per-backend timeouts, including for its `llm` backend).
   * Default 15 s.
   */
  timeoutMs?: number;
}

/** Try each entry in order; the first trusted, valid label routes. */
export async function decide(req: DecideRequest): Promise<DecisionOutcome> {
  const attempts: DecisionAttempt[] = [];
  const timeoutMs = req.timeoutMs ?? DECIDER_TIMEOUT_MS;
  let routed: { label: string; entry: string; payload?: unknown } | undefined;
  let lastPayload: unknown;

  for (const entry of req.entries) {
    if (req.signal?.aborted) {
      attempts.push({ entry, outcome: "aborted", latencyMs: 0 });
      return { ok: false, attempts, aborted: true, payload: lastPayload };
    }
    const t0 = performance.now();
    const isAgent = entry === "agent" || entry === "system-one";
    const timeoutCtl = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, timeoutCtl.signal]) : timeoutCtl.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let res: EntryResult;
    try {
      const running = req.run(entry, signal);
      if (isAgent) {
        res = await running;
      } else {
        res = await Promise.race([
          running,
          new Promise<EntryResult>((resolve) => {
            timer = setTimeout(() => {
              timeoutCtl.abort();
              resolve({ ok: false, outcome: "timeout", reason: `no answer within ${timeoutMs} ms` });
            }, timeoutMs);
          }),
        ]);
      }
    } catch (err) {
      res = { ok: false, outcome: "error", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latencyMs = Math.round(performance.now() - t0);
    if (res.payload !== undefined) lastPayload = res.payload;

    if (req.signal?.aborted) {
      attempts.push({ entry, outcome: "aborted", latencyMs });
      return { ok: false, attempts, aborted: true, payload: lastPayload };
    }

    if (!res.ok) {
      attempts.push({ entry, outcome: res.outcome, ...(res.reason ? { reason: res.reason } : {}), latencyMs });
      continue;
    }

    const a = res.answer;
    const base = {
      entry,
      label: a.label,
      confidence: a.confidence,
      ...(a.mode ? { mode: a.mode } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.usage !== undefined ? { usage: a.usage } : {}),
      latencyMs,
    };
    if (!req.labels.includes(a.label)) {
      attempts.push({ ...base, outcome: "invalid-label", reason: `"${a.label}" is not one of: ${req.labels.join(", ")}` });
      continue;
    }
    const trusted = res.authoritative === true || isTrusted(a, req, res.calibrated === true);
    if (!trusted) {
      attempts.push({ ...base, outcome: "untrusted", trusted: false });
      continue;
    }
    attempts.push({ ...base, outcome: "ok", trusted: true });
    routed = { label: a.label, entry, payload: res.payload };
    break;
  }

  if (!routed) return { ok: false, attempts, payload: lastPayload };
  for (const at of attempts) {
    if (at.outcome === "untrusted" && at.label !== undefined) at.agreed = at.label === routed.label;
  }
  return { ok: true, label: routed.label, routedBy: routed.entry, attempts, payload: routed.payload };
}

/** Human-readable list of attempts for an exhausted-chain error. */
export function describeAttempts(attempts: DecisionAttempt[], labels: string[]): string {
  const lines = attempts.map((a) => {
    const bits: string[] = [a.outcome];
    if (a.label !== undefined) bits.push(`label "${a.label}"`);
    if (a.confidence !== undefined && a.entry !== "agent") bits.push(`confidence ${a.confidence.toFixed(2)}`);
    if (a.reason) bits.push(a.reason);
    return `  - ${a.entry}: ${bits.join(", ")}`;
  });
  return `valid labels: ${labels.join(", ")}\n${lines.join("\n")}`;
}
