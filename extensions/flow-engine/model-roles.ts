// ---------------------------------------------------------------------------
// Flow Engine -- Model Role Resolution
//
// Resolves model references that may use role aliases (`@planning`),
// explicit model IDs with optional thinking suffixes (`model-id:high`),
// or plain model IDs.
// ---------------------------------------------------------------------------

/**
 * Resolve a model reference string into a concrete model ID and optional
 * thinking level.
 *
 * Supported formats:
 *
 * 1. **Role alias** -- `@planning`, `@coding`, etc.
 *    Resolved via the `getModelRole` callback.  The `thinking` parameter is
 *    passed through unchanged.
 *
 * 2. **Model ID with thinking suffix** -- `claude-sonnet-4-20250514:high`
 *    The part after `:` is used as the thinking level *unless* `thinking`
 *    was already provided (explicit `thinking` wins).
 *
 * 3. **Plain model ID** -- `claude-sonnet-4-20250514`
 *    Returned as-is with the optional `thinking` parameter.
 *
 * @param modelRef    The raw model reference from agent/flow config.
 * @param thinking    Optional explicit thinking level override.
 * @param getModelRole  Callback to resolve role aliases (required when
 *                      `modelRef` starts with `@`).
 */
export function resolveModel(
  modelRef: string,
  thinking?: string,
  getModelRole?: (role: string) => string | undefined,
): { modelId: string; thinking?: string } {
  // --- Role alias (@role) ---
  if (modelRef.startsWith("@")) {
    const role = modelRef.slice(1);
    if (!getModelRole) {
      throw new Error(`Cannot resolve @${role}: getModelRole not provided`);
    }
    const resolved = getModelRole(role);
    if (!resolved) {
      throw new Error(`Unknown model role: @${role}`);
    }
    return { modelId: resolved, thinking };
  }

  // --- Model ID with thinking suffix (id:level) ---
  if (modelRef.includes(":")) {
    const [id, thinkingSuffix] = modelRef.split(":");
    return { modelId: id, thinking: thinking || thinkingSuffix };
  }

  // --- Plain model ID ---
  return { modelId: modelRef, thinking };
}
