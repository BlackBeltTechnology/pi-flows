// ---------------------------------------------------------------------------
// Parent-session model runtime access
//
// pi's `ModelRuntime` is the providers + API keys table a session streams
// through. Flow agent sessions must share the parent session's runtime so
// providers registered at runtime (`pi.registerProvider`, e.g. the dashboard's
// providers.json) are usable — otherwise `createAgentSession` builds a fresh
// disk-only runtime and requests fail with "No API key found".
//
// Only providers/keys are shared; the agent's MODEL is never inherited.
//
// pi exposes the runtime to extensions only through `ctx.modelRegistry`, whose
// `runtime` field is private (TypeScript-only). There is no public accessor yet,
// so this is the single place that reads it. If pi renames the field, this
// returns undefined (agents fall back to pi's default runtime) and the canary
// test `model-runtime-accessor.test.ts` fails.
// ---------------------------------------------------------------------------

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Return the runtime behind a pi `ModelRegistry`, or undefined when unreadable. */
export function getModelRuntime(registry: unknown): ModelRuntime | undefined {
  try {
    const runtime = (registry as { runtime?: any } | null | undefined)?.runtime;
    if (runtime && typeof runtime.prepareRequest === "function" && typeof runtime.getModel === "function") {
      return runtime as ModelRuntime;
    }
  } catch {
    // Unreadable (e.g. a throwing getter) — degrade to the default runtime.
  }
  return undefined;
}
