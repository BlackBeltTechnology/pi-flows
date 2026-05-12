# Dashboard-side delegation brief

This change in `pi-flows` (`align-with-dashboard-plugins`) lands a number of fixes locally, but ONE 3-line follow-up needs to be made in `pi-agent-dashboard`. This brief documents it so it can be delegated as a separate PR there.

## Context

When `pi-flows` had no `LICENSE` file, the dashboard's `bundle-recommended-extensions.mjs` script's license allowlist (MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC) rejected it. The dashboard team added an exclusion comment in `BUNDLED_EXTENSION_IDS` so first-run installs would skip pi-flows rather than fail the entire bundle step.

pi-flows now has an MIT `LICENSE` (committed `fe5f119`) AND `"license": "MIT"` in its `package.json`. The exclusion comment is stale, and the bundling logic SHOULD now include pi-flows.

## Required change

**File:** `pi-agent-dashboard/packages/shared/src/recommended-extensions.ts`

**Current state (around line 180):**

```typescript
export const BUNDLED_EXTENSION_IDS: readonly string[] = [
	"pi-anthropic-messages",
	// "pi-flows" is intentionally NOT bundled until the upstream repo declares
	// an SPDX-conformant license (`LICENSE` file or `package.json#license`).
	// The bundle-recommended-extensions.mjs license allowlist enforcement
	// (MIT/Apache-2.0/BSD-2-Clause/BSD-3-Clause/ISC) correctly rejects it.
	// Re-add this entry once https://github.com/BlackBeltTechnology/pi-flows
	// has a license declared. See: openspec/changes/archive/
	// 2026-04-21-bundle-first-party-extensions/design.md §"License blockers".
];
```

**Replace with:**

```typescript
export const BUNDLED_EXTENSION_IDS: readonly string[] = [
	"pi-anthropic-messages",
	"pi-flows",
];
```

## Verification

After the PR lands in `pi-agent-dashboard`:

```bash
cd pi-agent-dashboard
grep -n '"pi-flows"' packages/shared/src/recommended-extensions.ts
# Expected: a line inside BUNDLED_EXTENSION_IDS, no comment block
```

And a dry-run of the bundling script:

```bash
node packages/electron/scripts/bundle-recommended-extensions.mjs --dry-run
# Expected: pi-flows is now included in the manifest
# No license-allowlist rejection messages
```

## Optional secondary cleanup

The same file likely has a related test under `packages/shared/src/__tests__/recommended-extensions.test.ts`. If the test enumerates excluded extensions or hard-codes the comment text, update that too (one or two lines).

## Why this is not in the pi-flows-side change

Cross-repo writes are out of scope for `align-with-dashboard-plugins`. The pi-flows change documents that pi-flows is bundle-eligible; this brief documents the receiving change in the dashboard repo.

This is a routine doc + array-entry update, no behavior changes beyond enabling the bundling for pi-flows.

## Suggested PR title

`chore(recommended-extensions): unblock pi-flows bundling (license is in place)`

## Reviewer context (one paragraph)

pi-flows now has MIT `LICENSE` and `"license": "MIT"` in `package.json` (commits `fe5f119` upstream). The stale comment in `BUNDLED_EXTENSION_IDS` referenced an absent license as the blocker; that blocker no longer exists. This PR removes the comment and adds `"pi-flows"` to the array so the Electron installer pre-delivers pi-flows on first launch alongside `pi-anthropic-messages`.

---

# Follow-up: relax `architect_error` reducer guard (added 2026-05-12)

## Context

While applying `align-with-dashboard-plugins`, I added companion `flow:architect-error` emissions alongside `flow:architect-init-error` so dashboard observers would see init failures. The companions were silently dropped: pi-flows emits architect init-errors BEFORE any state-creating event (`architect_started` or `architect_context_generating`), so by the time `architect_error` reaches the reducer, `state === null` and the guard at the top of the case skips the update:

```typescript
// packages/flows-plugin/src/architect-reducer.ts
case "architect_error": {
  if (!state) return null;        // ← init-errors get dropped here
  const summary = (data.summary as string) || (data.error as string) || "Unknown error";
  return { ...state, error: summary };
}
```

The companion emissions were reverted in commit `<followup-sha>` because they did nothing useful in their then-current shape. The init-error UX gap on the dashboard remains.

## Required change

**File:** `pi-agent-dashboard/packages/flows-plugin/src/architect-reducer.ts`

Drop the `if (!state) return null;` guard from the `architect_error` case so init-errors create a minimal state object with the error populated. Suggested shape:

```typescript
case "architect_error": {
  const summary = (data.summary as string) || (data.error as string) || "Unknown error";
  if (!state) {
    return {
      // minimal state — fill required fields with the most permissive defaults
      phase: "error",
      architectMode: ((data.mode as "new" | "edit") || "new"),
      flowName: (data.flowName as string) || "",
      agents: [],
      dagSteps: [],
      parsedFlows: [],
      lastToolCall: null,
      iteration: 1,
      resolvedModel: undefined,
      modelAlias: undefined,
      error: summary,
    };
  }
  return { ...state, error: summary };
}
```

Exact field defaults depend on the current `ArchitectState` type — implementer should consult `packages/shared/src/types.ts`. The intent is: if `architect_error` arrives first, create state in an `"error"` phase so the UI can render the message; if state already exists, just attach the error like before.

## Validation

- Add `flow:architect-error` companion emissions back in pi-flows' `extensions/flow-workspace/index.ts` (revert the revert) once the reducer change lands.
- Smoke: trigger `no-flows` and `agent-not-found` init failures; confirm the dashboard's `ArchitectErrorView` (or whichever component handles `architectState.error`) displays the message.

## Out-of-scope alternatives that were considered

- **Emit `architect_context_generating` before each init-error** in pi-flows. Creates the state correctly but flashes the architect overlay for ~100ms before clearing. Behaviorally dishonest ("started" is a lie). Rejected.
- **Add a new `architect_init_failed` event type** with its own reducer case that doesn't require pre-existing state. Cleaner separation but requires `FLOW_EVENT_MAP` extension AND a new reducer case AND a UI affordance. Heavier than the guard relaxation.
