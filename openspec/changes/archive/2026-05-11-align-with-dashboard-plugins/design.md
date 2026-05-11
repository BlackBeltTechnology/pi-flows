## Context

pi-flows is a pi extension that owns the flow execution engine and emits `flow:*` lifecycle events. pi-agent-dashboard has finished a major refactor extracting flow rendering into its own workspace plugin (`packages/flows-plugin/`, commits `234b45c` through `f75b3ea9`), giving plugins a clean separation between event source (pi-flows) and event renderer (dashboard plugin).

The dashboard's bridge extension (`packages/extension/src/flow-event-wiring.ts`) maintains a `FLOW_EVENT_MAP` table that translates pi-flows event names to dashboard protocol event types. Investigation revealed:

- pi-flows emits 46 distinct `flow:*` events total
- 27 of them are wired in `FLOW_EVENT_MAP`
- 19 are intentionally TUI-only or RPC-style (no dashboard observer needed)
- **2 are gaps**: `flow:architect-init-error` and `flow:architect-abort` are emitted but never reach the dashboard, leaving the UI stuck in "running" state on architect crashes and aborts
- **1 is asymmetric**: `flow:summary-started` is wired in `FLOW_EVENT_MAP` (→ `flow_summary_started`) but pi-flows never emits it; only `flow:summary-ready` is emitted

Additionally, pi-flows' `package.json` declares every pi-namespace `peerDependency` as `"*"`, which is unpublishable on npm and creates resolution uncertainty for any downstream package that wants to consume pi-flows via npm.

Finally, an earlier draft change in this repo (`expose-as-dashboard-plugin`, now deleted) planned to relocate flows-plugin React source from the dashboard repo into pi-flows. Subsequent dashboard-side commits (`add-plugin-ui-primitive-registry`) make that move unnecessary and arguably wrong — the primitive registry pattern keeps plugins light and portable without source relocation. The contributor-facing documentation needs a clear note closing that question.

## Goals / Non-Goals

**Goals**
- Make every architect lifecycle event observable on the dashboard side, with no UI state stuck in "running" after a terminal architect failure or abort.
- Add `flow:summary-started` so dashboard observers can show a "generating summary…" intermediate state.
- Make `pi-flows/package.json` publishable: every peerDependency declares a real semver range.
- Document the engine-emits / dashboard-renders split so the recurring "should we move flows-plugin into pi-flows?" question has a written, citable answer.

**Non-Goals**
- Moving flows-plugin React source into pi-flows. The dashboard's primitive registry direction supersedes this.
- Adding React tooling (vite, vitest, jsdom) to pi-flows. None of the goals require it.
- Modifying the dashboard's bridge or `FLOW_EVENT_MAP` table from this repo. Where a cross-repo change is needed, it is delegated and documented, not executed here.
- Adding a `pi-dashboard-plugin` manifest field to `pi-flows/package.json`. The dashboard's loader globs `<dashboard>/packages/*` — it never reads pi-flows' manifest. Adding the stub would be ceremony with no effect.

## Decisions

### Decision 1: Architect init-error and abort use additive emission, not renaming

Two options were considered for surfacing `flow:architect-init-error` and `flow:architect-abort` to the dashboard:

```
Option A: Rename to a mapped event.
   Pro: One event per failure mode, no duplicates.
   Con: Breaks every internal listener in extensions/flow-tui.ts
        and extensions/flow-prompt.ts that listens on the old name.
        Migration is invasive: 4 emit sites and 4 listen sites
        across 4 files.

Option B: Additive emission — also emit a mapped event.
   Pro: Existing TUI listeners keep working unchanged.
        Migration touches only emit sites; listen sites untouched.
        Aligns with how the codebase already differentiates concerns
        (TUI-only events stay TUI-only; dashboard-visible events
        get an explicit bridged emission).
   Con: Two events per failure (one TUI-internal, one dashboard-
        visible). Mitigated by clear field semantics: the bridged
        event carries phase/reason metadata that distinguishes it
        from a generic mid-flight error.

Option C: Cross-repo fix — add new entries to FLOW_EVENT_MAP.
   Pro: Zero changes in pi-flows.
   Con: Requires coordinated PR. Doesn't fix the architectural
        misalignment (the events were never named to match the
        dashboard's protocol naming convention; they were ad-hoc).
```

**Chosen: Option B (additive emission).**

Specifics:

- `flow:architect-init-error` keeps emitting at all 4 current sites. In ADDITION, each site emits `flow:architect-error` with `{ phase: "init", reason: <existing reason field> }`. The dashboard's existing `FLOW_EVENT_MAP["flow:architect-error"] = "architect_error"` mapping then bridges it. No `FLOW_EVENT_MAP` change needed.
- `flow:architect-abort` keeps emitting. In ADDITION, the emit site emits `flow:architect-cancelled` with `{ reason: "user-abort" }`. The dashboard's existing `FLOW_EVENT_MAP["flow:architect-cancelled"] = "architect_cancelled"` mapping bridges it. No `FLOW_EVENT_MAP` change needed.

### Decision 2: `flow:summary-started` is emitted at the top of the `flow:complete` handler

The current summary lifecycle (in `extensions/flow-summary/index.ts`) does:

```
flow:complete handler invoked
   ↓
compute stats from FlowResult
   ↓
resolveNextStep (async, may consult disk)
   ↓
persist summary markdown + JSON to disk
   ↓
setSummaryState (TUI state mutation)
   ↓
emit flow:summary-ready (← dashboard observable)
```

The `flow:summary-started` emission SHALL fire immediately upon entering the `flow:complete` handler, before any computation. Rationale:

- Avoids a race where the user dismisses the summary before "started" reaches the dashboard
- Matches the principle established by `flow:flow-started` / `flow:agent-started`: started fires at lifecycle entry, not mid-computation
- The dashboard's reducer can transition `summaryState` to "generating" immediately, eliminating the silent gap currently visible to users running long flows with large `FlowResult` payloads

Payload: `{ flowName: fr.flowName }`. No other fields are stable at lifecycle entry.

### Decision 3: peerDependency pinning uses caret of currently installed version

Current pi-flows `node_modules` versions:

```
@mariozechner/pi-ai            0.69.0
@mariozechner/pi-coding-agent  0.69.0
@mariozechner/pi-tui           0.69.0
@sinclair/typebox              0.34.49
```

Pinning rule: for each peer, declare `^<installed-version>`. This represents:

- The lowest version we have CI-tested against (the version in `node_modules`)
- An open upper bound consistent with semver caret semantics
- A real, parseable specifier that npm will accept on publish

Pinned ranges:

```
"@mariozechner/pi-ai":            "^0.69.0"
"@mariozechner/pi-coding-agent":  "^0.69.0"
"@mariozechner/pi-tui":           "^0.69.0"
"@sinclair/typebox":              "^0.34.49"
```

`devDependencies` (which currently mirror the peerDeps with `"*"`) are pinned the same way for consistency.

### Decision 4: docs/dashboard-integration.md is short and authoritative

The doc SHALL be ~1 page of prose with one architecture diagram. It is NOT a tutorial. It is a citable reference that contributors can link to when the cross-repo move question resurfaces (it WILL resurface — three times in our exploration alone).

Required content blocks:
- Two-repo split diagram (engine here, renderer in dashboard)
- Pointer to `packages/flows-plugin/` in pi-agent-dashboard with permalink
- Pointer to `extensions/flow-engine/` in this repo
- Explicit statement: "Moving flows-plugin source into pi-flows is NOT planned. The dashboard's add-plugin-ui-primitive-registry pattern makes the move unnecessary."
- One-paragraph "How to add a new flow event" recipe (emit here, add entry in dashboard's `FLOW_EVENT_MAP`)

Linked from main `README.md` under a new "Integration with pi-agent-dashboard" section.

### Decision 5: Cross-repo cleanup is delegated, not executed

The dashboard-side staleness (`pi-flows intentionally NOT bundled until license declared` comment + missing `BUNDLED_EXTENSION_IDS` entry) is real but lives in pi-agent-dashboard, not here. This change SHALL produce a brief in `openspec/changes/align-with-dashboard-plugins/DASHBOARD-DELEGATION-BRIEF.md` documenting the 3-line PR needed in the other repo. The PR itself is not part of this change's tasks.

## Risks / Trade-offs

- **[Risk] Double-emission of architect failure events creates duplicate UI feedback.**
  Mitigation: the dashboard's reducer is idempotent for these event types (reducing the same `architect_error` payload twice produces the same state). The duplicate is a minor protocol-level inefficiency, not a UX issue. If telemetry shows it's a problem, future work can rename emit sites in pi-flows (Option A from Decision 1) without breaking anything.

- **[Risk] peerDep pinning to `^0.69.0` rejects older pi-* installs that may have worked previously.**
  Mitigation: `"*"` was a placeholder, not a tested compatibility range. No CI ever validated pi-flows against pre-0.69 pi-coding-agent. The pin codifies what's actually known to work.

- **[Risk] Adding `flow:summary-started` could be expected by other observers we don't know about.**
  Mitigation: the event name is already wired in dashboard's `FLOW_EVENT_MAP`, indicating the dashboard team designed for it. Pi-flows is the only emitter today; no other consumer can have an existing expectation.

- **[Trade-off] No npm publish step in this change.**
  pi-flows remains installed via git URL (`source: "https://github.com/BlackBeltTechnology/pi-flows.git"` in dashboard's recommended-extensions). The peerDep pin makes future publishing possible but does not require it now. Publishing is its own change once the team decides on a scope (`pi-flows` bare vs `@blackbelt-technology/pi-flows`).

- **[Trade-off] No verification that flow:architect-init-error's TUI listener still works correctly.**
  The existing listener in `flow-tui.ts:799` continues to receive the un-renamed event. We're adding a parallel emission, not changing the original. But there is no automated test exercising the architect init-error path in this repo. Manual verification is required.

## Migration Plan

This change is incremental and additive:

1. Land in a single PR. Three independent surface areas (event emission, package.json, docs) are decoupled and could be split across PRs if preferred, but combining them keeps the changeset small (~20 LOC) and verifiable in one review pass.
2. Coordinate the cross-repo dashboard delegation (per `DASHBOARD-DELEGATION-BRIEF.md`) either before or after this lands. The two changes are independent.
3. No data migration. No config migration. No npm version bump required.

Rollback: revert the commit. The additive event emissions silently disappear; the dashboard reverts to its current silent-failure state for the two architect events and the summary "generating" intermediate state. No data corruption is possible.

## Open Questions

1. **Should we also emit `flow:summary-error` for the catch block in `extensions/flow-summary/index.ts`?**
   The current `try { writeFileSync(...) } catch { /* swallow */ }` silently absorbs disk-write failures. The dashboard has no observer for this case and the user never sees the "started" complete. Worth a follow-up change. Tracked but not addressed here.

2. **Is `phase: "init"` the right field name for distinguishing the additive emission?**
   Alternative: `errorKind: "init-error" | "mid-flight" | ...`. Decision deferred to implementer; either is reasonable as long as the field is documented in `docs/dashboard-integration.md`.

3. **Should `docs/dashboard-integration.md` cover the TUI overlay's relationship to dashboard rendering?**
   The TUI overlay (`extensions/flow-dashboard/`) and the React renderer (in dashboard repo) consume the same events but with different rendering targets. Worth a paragraph in the doc to head off "why two dashboards?" questions. Will include if it fits in one page; if not, defer to a separate explainer.
