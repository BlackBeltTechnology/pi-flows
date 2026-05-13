// ---------------------------------------------------------------------------
// Abort utilities — small pure helpers used by flow-execution to race the
// parallel agent batch against the run-level AbortSignal.
//
// Without these helpers, `await Promise.all(batch)` keeps the parent loop
// waiting for every in-flight agent to observe the signal at its own next
// iteration boundary. The race wrapper lets the parent unwind immediately;
// pending children still call `session.abort()` via their existing listener
// and clean themselves up in the background.
//
// See change: fix-pi-flows-end-to-end (Group 3).
// ---------------------------------------------------------------------------

import { FlowCancelledError } from "./flow-execution.js";

/**
 * Returns a promise that REJECTS with `FlowCancelledError` when the given
 * signal is aborted. If the signal is undefined the promise never settles.
 * If the signal is ALREADY aborted at call time the promise rejects on the
 * next microtask (idempotent / safe to call multiple times).
 *
 * The listener is auto-removed on rejection so the helper is safe to use
 * inside hot Promise.race loops without leaking listeners.
 */
export function signalRejection(signal?: AbortSignal): Promise<never> {
  if (!signal) {
    // Never settles — Promise.race ignores this branch entirely.
    return new Promise<never>(() => {});
  }
  if (signal.aborted) {
    return Promise.reject(new FlowCancelledError());
  }
  return new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new FlowCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Race a worker promise against the run signal. Settles with `worker`'s
 * resolution under normal conditions; rejects with `FlowCancelledError` as
 * soon as the signal fires, even if `worker` is still pending.
 */
export function raceWithAbort<T>(worker: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return worker;
  return Promise.race([worker, signalRejection(signal)]);
}
