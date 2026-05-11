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
