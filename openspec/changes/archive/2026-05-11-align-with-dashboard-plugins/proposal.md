## Why

The pi-agent-dashboard team has finished extracting flow rendering into a self-contained plugin (`@blackbelt-technology/pi-dashboard-flows-plugin`) that lives in the dashboard repo, consumes `flow:*` events emitted by pi-flows, and renders them via slot claims. That work is largely complete and supersedes earlier plans to relocate React source into pi-flows. With the architecture stable on the dashboard side, pi-flows has a small set of remaining items to make event emission, packaging, and contributor expectations match the new system. None of them is structural — they are protocol completeness, publishing hygiene, and documentation.

## What Changes

- **Bridge two missed event emissions** so dashboard observers receive every architect lifecycle state:
  - `flow:architect-init-error` is emitted by the engine but the dashboard's `FLOW_EVENT_MAP` has no entry for it; the architect crash path therefore never surfaces in the UI. Decide whether pi-flows should rename to a mapped event or whether the dashboard should add the entry (in either case, document on this side).
  - `flow:architect-abort` is emitted by the engine but is not bridged. Same disposition.
- **Emit `flow:summary-started`** (or formally drop it). The dashboard's `FLOW_EVENT_MAP` wires `flow:summary-started → flow_summary_started`, but pi-flows only ever emits `flow:summary-ready`. The "started" half is missing, so the dashboard never shows the "generating summary…" intermediate state.
- **Pin peerDependencies away from `"*"`** to make the package publishable. Today every peer dep is `"*"`, which npm rejects on publish with a warning and which prevents the package from being installable as a real semver-pinned dependency in other workspaces.
- **Document the integration architecture** in a new `docs/dashboard-integration.md`. Explains that pi-flows owns the engine + events; the dashboard's flows-plugin owns the React reaction; the two repos are intentionally separate; cross-repo source moves are not planned (the dashboard's primitive-registry direction supersedes them). This closes the door on the recurring "should we move flows-plugin into pi-flows?" question.
- **Delegate the dashboard-side cleanup** (NOT executed in this change, but tracked for a separate dashboard-repo PR):
  - Remove the stale "pi-flows intentionally NOT bundled until license declared" comment in `pi-agent-dashboard/packages/shared/src/recommended-extensions.ts` — pi-flows now has an MIT `LICENSE`.
  - Add `"pi-flows"` to `BUNDLED_EXTENSION_IDS` so the Electron installer pre-delivers pi-flows on first launch.

## Capabilities

### New Capabilities

- `dashboard-event-emission`: pi-flows' contract for emitting `flow:*` events that pi-agent-dashboard observes. Covers which events MUST be emitted at which lifecycle points, naming conventions, and the symmetric-pair invariant (every `*-started` event has a matching `*-ready` / `*-complete` / `*-error`).

### Modified Capabilities

None — there are no existing pi-flows specs in `openspec/specs/` whose requirements change. The repo currently ships only an archived dead-code-cleanup change with no live spec capabilities.

## Impact

### Code
- `extensions/flow-summary/index.ts` — emit `flow:summary-started` at the entry of the summary generation path.
- `extensions/flow-engine/flow-tui.ts` or the engine source that triggers `architect-init-error` / `architect-abort` — either rename to a mapped event or note the asymmetric contract.
- `package.json` — peerDependencies pin from `"*"` to caret ranges matching the versions currently used in `node_modules/`.
- New `docs/dashboard-integration.md` — ~2 pages explaining the two-repo split.

### Cross-repo (delegated, not in this change)
- `pi-agent-dashboard/packages/shared/src/recommended-extensions.ts` — stale comment removal + `BUNDLED_EXTENSION_IDS` entry.
- `pi-agent-dashboard/packages/extension/src/flow-event-wiring.ts` — optionally add `flow:architect-init-error` and `flow:architect-abort` to `FLOW_EVENT_MAP` if we choose the "dashboard adds entry" disposition for those two events.

### Dependencies
- No runtime dependency changes. The peerDeps pin is the only `package.json` adjustment.

### Risk
- Low. The two missed events are currently silent failure modes (no UI feedback on architect crash / abort, no "generating…" indicator). Adding them is additive; no consumer breaks.
- The peerDep pin could theoretically tighten resolution for an existing pi-flows user with an old `@mariozechner/pi-*` install — but `"*"` is unbounded above, not below, so any user who works today will continue to work after the pin (we pin to the lower bound that currently works).
- The docs file has no runtime effect.
