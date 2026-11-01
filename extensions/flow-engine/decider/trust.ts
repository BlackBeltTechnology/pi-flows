// ---------------------------------------------------------------------------
// Trust policy — decides whether a classifier answer routes or is shadow.
// See change: classifier-decisions (D4).
// ---------------------------------------------------------------------------

import type { DecisionAnswer, TrustPolicy } from "./types.js";

/**
 * - `calibrated`: System One mode must be `enforce`.
 * - `confidence`: confidence >= minConfidence.
 * - `auto`: `calibrated` when a calibration record exists, else `confidence`.
 */
export function isTrusted(
  answer: Pick<DecisionAnswer, "confidence" | "mode">,
  policy: TrustPolicy,
  calibrationExists: boolean,
): boolean {
  const effective = policy.trust === "auto" ? (calibrationExists ? "calibrated" : "confidence") : policy.trust;
  if (effective === "calibrated") return answer.mode === "enforce";
  return answer.confidence >= policy.minConfidence;
}
