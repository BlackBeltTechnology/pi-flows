# Tasks — align-with-dashboard-plugins

## 1. Architect init-error: additive emission

- [x] 1.1 Locate the four `pi.events.emit("flow:architect-init-error", ...)` sites: `extensions/flow-workspace/index.ts` lines 249, 304, 642 and any others. Verify the search via `grep -rn 'architect-init-error' extensions/`.
- [x] 1.2 For each site, immediately after the existing `flow:architect-init-error` emit, add a parallel emit: `pi.events.emit("flow:architect-error", { phase: "init", reason: <same-reason>, message: <human-readable> });`
- [x] 1.3 Verify the existing listener in `extensions/flow-engine/flow-tui.ts:799` continues to receive the un-renamed `flow:architect-init-error` and reacts as before (TUI breadcrumb / overlay state). No change here.
- [x] 1.4 Manual smoke: trigger `no-flows` and `agent-not-found` init failures (the two reasons currently emitted) and confirm both the TUI breadcrumb appears AND a corresponding `architect_error` protocol message reaches the dashboard.

## 2. Architect abort: additive emission

- [x] 2.1 Locate the `pi.events.emit("flow:architect-abort", {})` site in `extensions/flow-engine/flow-tui.ts:660`.
- [x] 2.2 Immediately after the existing emit, add: `pi.events.emit("flow:architect-cancelled", { reason: "user-abort" });`
- [x] 2.3 Confirm all `pi.events.on("flow:architect-abort", ...)` listeners (in `flow-prompt.ts:92`, `flow-workspace/index.ts:375`, `:708`, `:964`) continue to fire on the un-renamed event. No change.
- [x] 2.4 Manual smoke: start an architect session, abort via TUI, confirm dashboard's `architectState.status` transitions to `cancelled` and no UI element remains stuck in a running state.

## 3. Summary lifecycle: emit `flow:summary-started`

- [x] 3.1 Open `extensions/flow-summary/index.ts`. Locate the `pi.events.on("flow:complete", async (data: unknown) => { ... })` handler (around line 83).
- [x] 3.2 At the very top of the handler body, after the existing `if (!fr?.flowName || !fr?.results) return;` guard, add: `pi.events.emit("flow:summary-started", { flowName: fr.flowName });`
- [x] 3.3 Confirm no existing code path depends on the absence of a `flow:summary-started` event (grep for the string in `extensions/` and in dashboard repo's `FLOW_EVENT_MAP` for sanity).
- [x] 3.4 Manual smoke: run any flow to completion; observe in dashboard that a `flow_summary_started` protocol event arrives before `flow_summary_ready`.

## 4. peerDependencies pin

- [x] 4.1 Read `package.json`. Confirm the four current peer entries are `"@mariozechner/pi-ai": "*"`, `"@mariozechner/pi-coding-agent": "*"`, `"@mariozechner/pi-tui": "*"`, `"@sinclair/typebox": "*"`.
- [x] 4.2 Read the installed versions: `node -p 'JSON.parse(require("fs").readFileSync("node_modules/@mariozechner/pi-ai/package.json")).version'` and the equivalent for the other three.
- [x] 4.3 Update `package.json`: replace each `"*"` peer specifier with `^<installed-version>`. Expected: `^0.69.0` for the three pi-* peers, `^0.34.49` for `@sinclair/typebox`.
- [x] 4.4 Apply the same pins to the matching `devDependencies` entries (which mirror peerDeps today).
- [x] 4.5 Run `npm install` (or `pnpm install`) and confirm no resolution change — the install graph SHALL be identical because the caret of the currently installed version satisfies itself.
- [x] 4.6 Confirm `npm pack --dry-run` (or `pnpm pack --dry-run`) produces a tarball without npm warnings about unbounded peer ranges.

## 5. Documentation

- [x] 5.1 Create `docs/dashboard-integration.md` (~1 page) with these sections in order: (a) one-paragraph summary of the two-repo split, (b) ASCII architecture diagram showing pi-flows engine → flow:* events → dashboard bridge extension → dashboard's flows-plugin React rendering, (c) "Where things live" table mapping concerns to repos/paths, (d) "How to add a new flow event" recipe with both repos' edit points, (e) explicit "Why flows-plugin source stays in dashboard repo" paragraph naming the primitive-registry direction.
- [x] 5.2 Add a new section to `README.md` titled "Integration with pi-agent-dashboard" with a 2-3 sentence summary and a link to `docs/dashboard-integration.md`. Place it after "Quick Start" and before any existing dashboard mentions.
- [x] 5.3 Cross-check `docs/dashboard-integration.md` references actual files that exist at the paths cited (use permalinks where possible).

## 6. Cross-repo delegation brief

- [x] 6.1 Create `openspec/changes/align-with-dashboard-plugins/DASHBOARD-DELEGATION-BRIEF.md` documenting the three-line PR needed in pi-agent-dashboard: (a) remove the stale "intentionally NOT bundled until license declared" comment in `packages/shared/src/recommended-extensions.ts`, (b) add `"pi-flows"` to the `BUNDLED_EXTENSION_IDS` array, (c) note that pi-flows now has MIT license at `LICENSE`.
- [x] 6.2 The brief SHALL include: the exact file path, the exact text to remove, the exact text to add, the verification command (`grep`-able check on the dashboard's `BUNDLED_EXTENSION_IDS`), and a short note explaining context for the reviewer.

## 7. Verification

- [x] 7.1 Run `openspec validate align-with-dashboard-plugins --strict` — must pass.
- [x] 7.2 Run `pnpm test` (or equivalent) in pi-flows. There are currently no automated tests in this repo, so this is a placeholder for future regression coverage. Document the absence in the brief if it still applies.
- [x] 7.3 Manual end-to-end check: spin up pi-agent-dashboard from source, point a session at this pi-flows checkout, run a flow that triggers (a) summary generation, (b) an architect init error (`no-flows` is the easiest reproducer), (c) a user-initiated abort during architect. Confirm all three surface in the dashboard UI.
- [x] 7.4 Confirm `git log --oneline` after this change does NOT touch any file under `extensions/flow-engine/flow-tui.ts:797-820` (the existing listener block) or any `flow:architect-*` listener path — the additive emission is upstream of these listeners.

## 8. Documentation + housekeeping

- [x] 8.1 Update CHANGELOG (or create one) with a top-level entry summarizing this change.
- [x] 8.2 If a release is imminent, bump `package.json#version` to the next patch (`0.1.1`) since the peerDep pin is a publishability fix even though no API surface changes.
