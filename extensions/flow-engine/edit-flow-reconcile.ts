// ---------------------------------------------------------------------------
// Change-gated reconcile for the edit-flow authoring tools.
//
// The `flow_agents`/`flow_write` tools are activated/deactivated to match the
// current `flows.editFlow` value. This reconcile runs at `session_start` (to
// seed) and at each `before_agent_start` (so an out-of-band settings change is
// picked up on the next agent turn, without a session restart).
//
// `setActiveTools` rebuilds the system prompt, so applying it every turn would
// be wasteful. The reconciler is therefore CHANGE-GATED: it only applies the
// tool set when the resolved `enabled` value differs from the last applied
// value. The first call always applies (seeding the cache).
// ---------------------------------------------------------------------------

export interface EditFlowToolReconcilerDeps {
  /** Current active tool names (pi.getActiveTools). */
  getActiveTools: () => string[];
  /** Replace the active tool set (pi.setActiveTools). */
  setActiveTools: (toolNames: string[]) => void;
  /** The authoring tool names gated by edit-mode, e.g. ["flow_agents","flow_write"]. */
  editFlowTools: readonly string[];
}

/**
 * Build a change-gated reconciler.
 *
 * The returned `reconcile(enabled)` activates the edit-flow tools when
 * `enabled` is true and removes them when false, but only touches the active
 * set (and thus rebuilds the prompt) when `enabled` changed since the last
 * call. Returns `true` when it applied a change, `false` when it was a no-op.
 */
export function makeEditFlowToolReconciler(
  deps: EditFlowToolReconcilerDeps,
): (enabled: boolean) => boolean {
  let last: boolean | undefined;
  const gated = new Set(deps.editFlowTools);

  return (enabled: boolean): boolean => {
    if (enabled === last) return false;
    const active = deps.getActiveTools().filter((n) => !gated.has(n));
    if (enabled) active.push(...deps.editFlowTools);
    deps.setActiveTools(active);
    last = enabled;
    return true;
  };
}
