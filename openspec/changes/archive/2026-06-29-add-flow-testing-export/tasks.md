# Tasks

## 1. Relocate the harness into the shipped tree
- [x] 1.1 Create `extensions/flow-engine/testing.ts` containing the faux-harness machinery, importing engine internals via sibling relative paths (`./execution.js`, `./flow-execution.js`, `./flow-parser.js`).
- [x] 1.2 Reduce `__tests__/faux-harness.ts` to a thin re-export (`export * from "../extensions/flow-engine/testing.js";`).
- [x] 1.3 Run `npx vitest run __tests__/faux-*.test.ts` — all faux suites pass unchanged against the relocated module.

## 2. Harden nested-pi-ai resolution (highest risk — see design.md Decision 3)
- [x] 2.1 Replace the directory walk-up with a `createRequire(...).resolve("@earendil-works/pi-coding-agent/package.json")` anchor; probe nested `dist/compat.js`, then a hoisted sibling resolved from pi-coding-agent's own `createRequire`; keep the walk-up only as a last-resort fallback.
- [x] 2.2 Throw a clear, layout-naming error when no `compat.js` is found (before any faux stream).
- [x] 2.3 Validate in a temp consumer package under **npm** (both deduped and version-pinned-nested) — a faux run completes without "No API provider registered".
- [x] 2.4 Validate in a temp consumer package under **pnpm** — same.

## 3. Add the public export
- [x] 3.1 Add `"./testing": "./extensions/flow-engine/testing.ts"` to `package.json#exports`; leave `"."` unchanged.
- [x] 3.2 Curate the named exports in `testing.ts` to the minimal surface (runners, verbs, helpers, `parseFlowYamlString`, types); do NOT export `runFlow` / `spawnAgent`.
- [x] 3.3 Verify `createRequire(...).resolve("@blackbelt-technology/pi-flows/testing")` succeeds from a temp consumer; `await import(".../testing")` exposes `runFauxFlow`, `spawnFaux`, `scriptFinish`, `parseFlowYamlString`.
- [x] 3.4 `npm pack --dry-run` — confirm `extensions/flow-engine/testing.ts` is included and `__tests__/` is NOT.

## 4. Specs & docs
- [x] 4.1 Sync (archive-time step — performed during `openspec archive`) `package-manifest` and `faux-model-testing` delta specs into main specs on archive.
- [x] 4.2 (Delegate to a docs subagent) Update `docs/testing.md` — document the `@blackbelt-technology/pi-flows/testing` import path for downstream authors, with a worked in-repo example, and note the npm/pnpm support matrix.
- [x] 4.3 (Delegate to a docs subagent) Add a "Testing your flow" pointer in `docs/creating-packages.md` linking to the new export.
- [x] 4.4 Update `README.md` if it enumerates public exports — NO-OP: README does not enumerate exports.

## 5. Release
- [x] 5.1 Add a CHANGELOG entry (new `pi-flows/testing` subpath export; downstream flow testing) — added under `## [Unreleased]`.
- [x] 5.2 Bump version per release policy — DEFERRED: kept at 0.3.0; the Release workflow mints the version (entry filed under Unreleased).
