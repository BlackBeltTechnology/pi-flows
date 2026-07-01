// ---------------------------------------------------------------------------
// Auto-end — gracefully end a non-interactive parent session when a flow it
// ran completes successfully.
//
// Gate (all must hold):
//   1. the flow opted in via top-level `auto_end: true` in flow.yaml
//   2. the session is non-interactive (no TUI) — an interactive human is
//      never closed out from under them
//   3. the flow reached terminal status "success" (never on abort or error)
//
// shutdown() is only ever reachable through the flow:complete listener, so a
// session can never be closed before its flow has terminated.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowConfig, FlowResult } from "./types.js";

export interface AutoEndDecisionInput {
  autoEnd: boolean | undefined; // flow.auto_end
  status: string | undefined; // FlowResult.status
  isInteractive: boolean; // ctx.hasUI captured at session_start
}

/** Pure gate: flow opted in AND non-interactive session AND status === "success". */
export function shouldAutoEnd(input: AutoEndDecisionInput): boolean {
  return input.autoEnd === true && !input.isInteractive && input.status === "success";
}

export interface AutoEndDeps {
  /** Resolve the completed flow's config to read its `auto_end` opt-in. */
  getFlow: (flowName: string) => FlowConfig | undefined;
  /** Whether the current session has a UI (interactive). */
  isInteractive: () => boolean;
  /** Graceful session shutdown (ctx.shutdown), or a no-op when unavailable. */
  shutdown: () => void;
}

/**
 * Register a flow:complete listener that gracefully ends the session when the
 * gate passes. Registered once at activate(); reads live interactivity and the
 * captured shutdown on each completion.
 */
export function registerAutoEndListener(pi: ExtensionAPI, deps: AutoEndDeps): void {
  pi.events?.on("flow:complete", (data: unknown) => {
    const result = data as FlowResult | undefined;
    if (!result || typeof result !== "object") return;
    const flow = deps.getFlow(result.flowName);
    if (
      shouldAutoEnd({
        autoEnd: flow?.auto_end,
        status: result.status,
        isInteractive: deps.isInteractive(),
      })
    ) {
      deps.shutdown();
    }
  });
}
