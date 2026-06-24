// ---------------------------------------------------------------------------
// Flow Engine -- Node Failure Model (pure classifiers)
//
// One failure model for every node type. A node resolves to exactly one of
// success | soft | hard:
//   - success : routes on_complete
//   - soft    : routes on_error, or hard-fails the flow when on_error is unset
//   - hard    : aborts in-flight siblings, skips pending steps, ends the flow
//               with status `error`
//
// All functions here are pure (no I/O, no SDK) so the routing rules can be
// unit-tested in isolation. See openspec/changes/node-failure-model.
// ---------------------------------------------------------------------------

import type { AgentResult, FailureInfo, FailureOutcome } from "./types.js";
import { FlowHardError } from "./types.js";

/**
 * Classify an agent run STRUCTURALLY — by how it terminated, never by parsing
 * error-message text and never via a deliberate "fatal" signal from the agent.
 *
 *   finish(status:"complete")              -> success
 *   finish(status:"error" | "blocked")     -> soft  (agent reported a logical failure)
 *   no finish + API error (retries gone)   -> hard  (provider unusable for the rest of the flow)
 *   no finish + no API error               -> soft  (agent stalled / ran out of turns)
 *
 * `lastApiError` is pi's terminal API error string (set on stopReason:"error"
 * after pi-coding-agent exhausted its own transient-retry budget).
 */
export function classifyAgentOutcome(
  finishParams: Record<string, any> | undefined,
  lastApiError: string | undefined,
): { outcome: FailureOutcome; failureInfo?: FailureInfo } {
  if (finishParams) {
    const status = finishParams.status as string | undefined;
    if (status === "complete") {
      return { outcome: "success" };
    }
    if (status === "error" || status === "blocked") {
      const message = finishParams.summary
        ? String(finishParams.summary)
        : `Agent reported status "${status}"`;
      return { outcome: "soft", failureInfo: { outcome: "soft", message, source: "agent_finish_error" } };
    }
    // Unknown/missing status with finish called — treat as soft (agent ran).
    return {
      outcome: "soft",
      failureInfo: { outcome: "soft", message: `Agent finished with unrecognized status "${status}"`, source: "agent_finish_error" },
    };
  }

  if (lastApiError) {
    return {
      outcome: "hard",
      failureInfo: { outcome: "hard", message: lastApiError, source: "api_error" },
    };
  }

  return {
    outcome: "soft",
    failureInfo: { outcome: "soft", message: "Agent did not call finish and produced no terminal API error", source: "agent_no_finish" },
  };
}

/**
 * Classify an error thrown by a code/extension node.
 * `FlowHardError` -> hard (ignores on_error); any other throw -> soft.
 */
export function classifyThrownError(err: unknown): FailureInfo {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof FlowHardError) {
    return { outcome: "hard", message, source: "flow_hard_error" };
  }
  return { outcome: "soft", message, source: "thrown_error" };
}

/**
 * Resolve the routing outcome for a finished node, applying the
 * "on_error is the soft switch" rule:
 *
 *   success            -> "success"
 *   hard               -> "hard"
 *   soft + on_error set -> "soft"
 *   soft + no on_error  -> "hard"  (fail-fast by default)
 *
 * Falls back to the legacy boolean (`result.success`) when a result predates
 * the `outcome` field, so mixed/legacy results still route deterministically.
 */
export function resolveRouteOutcome(
  result: Pick<AgentResult, "success" | "outcome">,
  onError: string | undefined,
): FailureOutcome {
  const outcome: FailureOutcome = result.outcome ?? (result.success ? "success" : "soft");
  if (outcome === "success") return "success";
  if (outcome === "hard") return "hard";
  // soft: recoverable only when the node declares an on_error target.
  return onError ? "soft" : "hard";
}
