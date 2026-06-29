# Design — public flow-testing API

## Context

`__tests__/faux-harness.ts` already drives the real `spawnAgent` / `runFlow` paths against a scripted, zero-network faux provider. The behaviour is proven (the `faux-*.test.ts` suites depend on it). This change is about **distribution and stability**, not new test behaviour: move the proven machinery into the published tree, expose a deliberately small surface, and make the one fragile mechanism — locating pi-coding-agent's nested `pi-ai` — survive a real install.

## Decision 1 — Module location: relocate, don't re-path

Move the harness body into `extensions/flow-engine/testing.ts` (which `files: ["extensions/"]` already ships). `__tests__/faux-harness.ts` becomes:

```ts
export * from "../extensions/flow-engine/testing.js";
```

Why relocate rather than just add `__tests__/` to `files[]` and export from there:

- `files: ["__tests__/"]` would ship the entire test suite as package payload — wrong shape, and couples published bytes to test layout.
- The shipped module can `import` engine internals (`./execution.js`, `./flow-execution.js`, `./flow-parser.js`) via **sibling** relative paths instead of `../extensions/...` deep paths — these resolve identically in-repo and when installed.

```
  BEFORE                              AFTER
  ──────                              ─────
  __tests__/faux-harness.ts           extensions/flow-engine/testing.ts   (shipped)
    └─ ../extensions/flow-engine/…       └─ ./execution.js  (sibling)
       (resolves only in-repo)            └─ ./flow-execution.js
                                          └─ ./flow-parser.js
  __tests__/*.test.ts ─► harness      __tests__/faux-harness.ts ─► re-export
                                      __tests__/*.test.ts ─► unchanged
```

## Decision 2 — Public surface: minimal, narrower than the initial sketch

The initial sketch was "re-export `runFlow`, `parseFlowYamlString`, a faux runner." On reflection, exporting `runFlow` / `spawnAgent` directly is a **semver liability**: it pins the engine's internal entry signatures as public API and blocks future refactors of the execution core.

Export only what a downstream author needs to test *their* flow, with the engine kept behind the faux runners:

| Exported | Kind | Why a downstream author needs it |
|---|---|---|
| `runFauxFlow` | runner | drive a full DAG (agents + code nodes + forks + loops) with faux agents |
| `spawnFaux` | runner | drive a single agent loop (guard / latch / retry / abort) |
| `runFaux` | runner | multi-agent DAG without code-node materialization |
| `scriptFinish`, `scriptToolThenFinish`, `scriptError`, `scriptSlowText` | verbs | script provider turns |
| `makeAgent`, `lastUserText` | helpers | build agent configs; route inside responders |
| `parseFlowYamlString` | loader | load the author's own `flow.yaml` into a `FlowConfig` |
| `FinishArgs`, `FauxResponseStep`, `AgentConfig`, `FlowConfig`, `FlowResult`, `AgentResult` | types | typed test code |

**Not exported:** `runFlow`, `spawnAgent`. They remain internal; the faux runners wrap them. This keeps the stable surface to "scripted faux testing" semantics, which we can preserve across engine refactors. (This is the documented divergence from the proposal's original full-`runFlow` wording.)

## Decision 3 — Nested-`pi-ai` resolution must survive a real install (the crux)

`@earendil-works/pi-coding-agent` bundles its own nested `@earendil-works/pi-ai`, and the api-provider registry is **module-scoped**. The faux provider must be registered into the *exact* `pi-ai/compat.js` instance that `createAgentSession` resolves streams through, or every run fails with **"No API provider registered."**

The current `resolveNestedCompatPath()` walks up from the harness file's own directory looking for `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js` (else a hoisted sibling). That assumes the **dev-clone layout**. Installed layouts differ by package manager:

```
  npm (deduped)            npm (version-pinned)        pnpm (symlink farm)
  ─────────────            ────────────────────        ───────────────────
  node_modules/            node_modules/               node_modules/
   ├ pi-flows/             ├ pi-flows/                  └ .pnpm/
   ├ …/pi-coding-agent/    ├ …/pi-coding-agent/           ├ pi-flows@x/node_modules/…
   └ …/pi-ai/  ◄ ONE copy  │   └ node_modules/…/pi-ai/    ├ pi-coding-agent@y/node_modules/…/pi-ai/
     (both import this)    │      ◄ nested copy           └ pi-ai@z/node_modules/…
                           └ …/pi-ai/ (other consumers)  symlinks cross-link the real dirs
```

The directory walk-up is brittle here — especially under pnpm, where the harness file lives deep inside `.pnpm/pi-flows@.../node_modules/...` and the upward path does not pass through pi-coding-agent's own tree.

**Decision:** anchor the resolution to **pi-coding-agent's real install location**, following the dependency edge instead of the directory structure:

1. `createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")` → pi-coding-agent's package dir (works across npm + pnpm because it follows the actual resolution graph).
2. Probe, in order:
   - `<pca-dir>/node_modules/@earendil-works/pi-ai/dist/compat.js` (nested copy — what its dist imports when version-pinned),
   - then a hoisted/sibling `@earendil-works/pi-ai/dist/compat.js` resolved from pi-coding-agent's own `createRequire`.
3. Keep the existing filesystem walk-up as a **last-resort fallback** so the dev-clone path is unaffected.
4. If all probes fail, throw a clear, actionable error naming the layout problem (not the raw "No API provider registered" that surfaces three frames later).

This is the single highest-risk task. It must be validated against a temp consumer package under **both npm and pnpm** before the export is considered "provided" — otherwise downstream users hit the failure in *their* repo where they cannot debug it.

> Note: the clean long-term fix is for pi-coding-agent to expose `registerFauxProvider` via a stable subpath export, which would delete this whole resolver. That's a separate-package change and is out of scope here; this design hardens what pi-flows can control today.

## Decision 4 — Provider import path

`extensions/flow-engine/testing.ts` imports `fauxAssistantMessage` / `fauxToolCall` / `fauxText` from `@earendil-works/pi-ai/providers/faux`. `pi-ai` is already a pi-flows dependency, so this resolves from pi-flows' own deps in both layouts. Only the **registration target** (Decision 3) needs pi-coding-agent's nested instance; the message-builder helpers are layout-agnostic.

## Risks

| Risk | Mitigation |
|---|---|
| pnpm layout defeats the resolver | Decision 3 anchors to pi-coding-agent via `createRequire`, not directory walk; validate on pnpm in tasks. |
| Engine refactor breaks public API | Surface excludes `runFlow`/`spawnAgent`; only faux-runner semantics are committed. |
| Shipping test code as payload | Relocate to `extensions/flow-engine/testing.ts`; do not add `__tests__/` to `files[]`. |
| `.ts` entry needs a TS loader | Same constraint as the `"."` export (`package-manifest` spec); downstream tests run under vitest, which is TS-aware. |
