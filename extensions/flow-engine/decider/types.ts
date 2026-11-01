// ---------------------------------------------------------------------------
// Decider chain — shared types. See change: classifier-decisions.
// ---------------------------------------------------------------------------

import type { TrustMode } from "../types.js";

export type Mode = "shadow" | "enforce";

/** One classifier (or agent) answer to the decision's single choice question. */
export interface DecisionAnswer {
  label: string;
  confidence: number;
  probabilities?: Record<string, number>;
  /** System One calibration mode; absent for pi-ai classifiers and agents. */
  mode?: Mode;
  model?: string;
  backendId?: string;
  usage?: unknown;
}

export type AttemptOutcome =
  | "ok"
  | "untrusted"
  | "invalid-label"
  | "no-backend"
  | "off-machine"
  | "credentials"
  | "timeout"
  | "error"
  | "aborted";

export type EntryResult =
  | {
      ok: true;
      answer: DecisionAnswer;
      /** A System One calibration record exists for this backend + decision point. */
      calibrated?: boolean;
      /** The entry is authoritative (the agent): the trust policy is not applied. */
      authoritative?: boolean;
      /** Opaque payload the caller wants back (e.g. the agent's AgentResult). */
      payload?: unknown;
    }
  | { ok: false; outcome: Exclude<AttemptOutcome, "ok" | "untrusted">; reason?: string; payload?: unknown };

/** What `flow:decision` carries per attempt. Never contains state or task text. */
export interface DecisionAttempt {
  entry: string;
  outcome: AttemptOutcome;
  label?: string;
  confidence?: number;
  mode?: Mode;
  trusted?: boolean;
  agreed?: boolean;
  model?: string;
  latencyMs: number;
  reason?: string;
  usage?: unknown;
}

export type DecisionOutcome =
  | { ok: true; label: string; routedBy: string; attempts: DecisionAttempt[]; payload?: unknown }
  | { ok: false; attempts: DecisionAttempt[]; aborted?: boolean; payload?: unknown };

export interface DecisionQuestion {
  state: Record<string, string>;
  question: { type: "choice"; instructions: string; criteria: Record<string, string> };
}

export interface TrustPolicy {
  trust: TrustMode;
  minConfidence: number;
}

/** Runs one non-agent classifier entry. */
export type ClassifierEntry = (q: DecisionQuestion, signal: AbortSignal) => Promise<EntryResult>;
