// First-correct-finish-wins latch for agent steps.
//
// `finish` is advisory, not a hard loop terminator: the harness reacts to a
// successful finish by aborting the session. A misbehaving model can emit two
// finish calls in one assistant message; pi-agent-core's parallel batch then
// emits both `tool_execution_start`s before the deferred `tool_execution_end`s,
// and a guard-blocked duplicate's error-end arrives BEFORE the real success-end
// (`start#1, start#2, end#2(error), end#1(success)`).
//
// This latch makes that order-independent: args are captured at END keyed by
// toolCallId, the FIRST non-error finish freezes the result, and every later
// finish end — success or error — is ignored. See change latch-agent-finish-result.

export interface FinishLatch {
  /** Record args seen at tool_execution_start, keyed by toolCallId. */
  start(toolCallId: string, args: unknown): void;
  /**
   * Process a finish tool_execution_end. Returns `true` exactly once — when the
   * first correct (non-error) finish latches and the caller should `abort()`.
   * Ends for unknown ids, errors before any latch, or anything after the latch
   * return `false` and never mutate the frozen result.
   */
  end(toolCallId: string, isError: boolean): boolean;
  /** The frozen result, set once on the first correct finish (else undefined). */
  readonly params: unknown | undefined;
  /** Whether a correct finish has been latched. */
  readonly latched: boolean;
}

export function createFinishLatch(): FinishLatch {
  const pending = new Map<string, unknown>();
  let params: unknown | undefined = undefined;
  let latched = false;

  return {
    start(toolCallId, args) {
      // Do NOT write `params` here — capturing at start lets a later finish
      // call clobber an earlier one. The result is only frozen on a good end.
      pending.set(toolCallId, args);
    },
    end(toolCallId, isError) {
      if (!pending.has(toolCallId)) return false;
      if (latched || isError) return false; // first correct finish wins; never clear
      params = pending.get(toolCallId);
      latched = true;
      return true; // caller aborts once
    },
    get params() {
      return params;
    },
    get latched() {
      return latched;
    },
  };
}
