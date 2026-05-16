# Add CI and Release Pipeline

## Why

pi-flows currently ships with **no GitHub Actions, no CI, no automated release**. The package is published manually (and has no git tags despite CHANGELOG already documenting `0.2.0` and `0.2.1`). There is no signal on PRs that tests pass, no protection against publishing a broken build, and no record of provenance on npm.

Meanwhile the sibling repo `pi-agent-dashboard` runs a complete CI/release pipeline: lint+test+build on every PR, automated `npm publish --provenance` via npm Trusted Publishing on tag-push, automatic GitHub Release creation from CHANGELOG sections. pi-flows should reach the same baseline, scaled down to its single-package shape.

Concrete gaps:

- **No CI signal.** A PR that breaks tests can be merged without anyone noticing until a downstream consumer hits the bug.
- **No type-check.** Without a build step, `tsc --noEmit` is the only thing that catches type errors before runtime — but nothing runs it.
- **No lint baseline.** Style and dead-code issues accrue silently.
- **No peer-dep matrix.** pi-flows declares `^0.74.0` peers and runs on whatever Node the user has; we have no evidence it works on 20, 22, AND 24.
- **Manual `npm publish`.** No provenance attestation, no required-reviewer gate, no protection against publishing the wrong commit.
- **No GitHub Release artifacts.** CHANGELOG entries exist but never get surfaced as release notes on github.com.

## What changes

Mirror `pi-agent-dashboard`'s CI/release setup, **scaled to pi-flows' single-package shape**. Drop everything that doesn't apply (electron, site, sync-versions, prerelease handling, release-notes-footer).

### CI (`.github/workflows/ci.yml`)

- Triggers: `push` to `develop`, `pull_request` targeting any branch.
- Runs on a Node matrix: **20, 22, 24** (catch peer-dep regressions across LTSes).
- Steps: `npm ci` → `npm run lint` → `npm run typecheck` → `npm test`.
- Adds two new package.json scripts to support the above:
  - `"lint": "eslint extensions __tests__"` — new ESLint config (TS + recommended rules, no fancy plugins).
  - `"typecheck": "tsc --noEmit"` — new `tsconfig.json` (project already imports types but has no tsconfig committed).

### Release (`.github/workflows/publish.yml`)

Two triggers:

1. **Tag push (`v*`)** — workflow extracts version from tag, publishes.
2. **`workflow_dispatch` with `version` input** — workflow bumps `package.json`, dates the matching `## [Unreleased]` section in `CHANGELOG.md` to `## [vX.Y.Z] - YYYY-MM-DD`, commits, tags, pushes, then publishes.

Three jobs (parity with dashboard, minus electron):

- **`prepare`** — resolve version, on dispatch: bump + tag + push.
- **`publish`** — `npm publish --provenance --access public`. Idempotent: skip if `npm view @blackbelt-technology/pi-flows@X.Y.Z` already returns. Uses npm **Trusted Publisher** via OIDC (`id-token: write` permission). Job runs in the **`npm-publish` GitHub environment** so a required-reviewer gate can be added later without changing workflow YAML.
- **`github-release`** — extract `## [vX.Y.Z]` section from `CHANGELOG.md` (same awk script as dashboard), create draft GitHub Release with that body. No assets to attach (npm-only package).

### Scope expansion (added during apply, 2026-05-16)

During implementation, the first `tsc --noEmit` run against a freshly-added `tsconfig.json` surfaced **19 pre-existing type errors** in `extensions/`. These are API drift against the current `@earendil-works/pi-coding-agent@^0.74.0` peer types: `ToolDefinition` gained `label`, `ExtensionUIContext` gained 5 methods, `AgentResult` gained 4 fields, `AgentStep` lost `.model`, etc. Operator decision: **fix them all in this change** rather than spinning a separate `fix-type-drift-with-pi-074` proposal. Rationale: typecheck must actually run in CI to be useful, and a CI workflow that's red on day 1 has no value. Scope is enlarged to include these fixes. See tasks 3a–3f.

### What's deliberately NOT included

- **No electron job.** pi-flows ships no binaries.
- **No site workflow.** pi-flows has no Astro site.
- **No `sync-versions.js`.** Single package, no inter-workspace deps.
- **No prerelease support (`-rc.N` → `next` dist-tag).** Add later if pi-flows ever ships a release candidate; not needed for the 0.2.x line.
- **No release-notes-footer.md.** Footer in dashboard exists for SmartScreen/Gatekeeper workarounds on unsigned binaries; pi-flows has no binaries.
- **No `sync-release-version.yml`.** Sibling to deploy-site — no site to sync to.
- **No PR linter / commit message check.** Out of scope; can follow.

## Impact

- **Affected specs:** new `release-pipeline` capability.
- **Affected code:**
  - New: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`.
  - New: `.eslintrc.json` (or `eslint.config.js`), `tsconfig.json`.
  - Modified: `package.json` — add `lint` + `typecheck` scripts, add `eslint` + `typescript` to `devDependencies`.
  - Modified: `README.md` — add a CI badge, a one-paragraph "Releasing" section pointing operators at the workflow_dispatch UI.
  - Modified: `CHANGELOG.md` — entry for this change.
- **Affected consumers:** none directly. Downstream `npm install` behaviour unchanged. Provenance attestation appears on npmjs.com for new releases.
- **Backward compatibility:** strictly additive. No existing file changes its public contract.
- **Prerequisites (external, not in this change):**
  - npm Trusted Publisher configured on `npmjs.com` for `@blackbelt-technology/pi-flows` (same scope as dashboard — likely already trusted, verify before first publish run).
  - GitHub repository environment named `npm-publish` created (can be empty initially; required-reviewer rule added later).
- **Out of scope:**
  - Prerelease (`-rc.N`) handling.
  - Lint auto-fix on PRs.
  - Branch protection rules (configured in GitHub UI, not in repo).
  - Migrating the existing `0.2.0` / `0.2.1` CHANGELOG entries to actual git tags (operator should retroactively tag once workflow lands; not blocking).
