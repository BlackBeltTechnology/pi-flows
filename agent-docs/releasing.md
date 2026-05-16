# Releasing pi-flows

Runbook. Cuts release of `@blackbelt-technology/pi-flows` to npm + GitHub.

Pipeline: `.github/workflows/publish.yml`.

## Overview

| | |
|---|---|
| **Triggers** | `workflow_dispatch` + tag push (`v*`) |
| **Jobs** | `prepare` → `publish` → `github-release` |
| **Registry** | npm. Trusted Publishing (OIDC). Provenance. |
| **GitHub Release** | Draft. Manual publish step. |

## Trigger paths

### 1. Workflow dispatch (recommended)

GitHub Actions UI → `Release` workflow → `Run workflow`. Type version (e.g. `0.2.2`). `prepare` bumps `package.json`, dates CHANGELOG heading, commits, tags `v0.2.2`, pushes. Downstream jobs run against pushed tag.

### 2. Tag push

Bump `package.json`. Edit `CHANGELOG.md`. Commit. Then:

```bash
git tag -a v0.2.2 -m v0.2.2
git push --follow-tags
```

`prepare` reads `GITHUB_REF_NAME`, strips `v`. Skips bump/commit/tag/push. Downstream jobs run.

## The three jobs

### `prepare`

Resolves version. On push: strip `v` from `GITHUB_REF_NAME`. On dispatch: validate `^[0-9]+\.[0-9]+\.[0-9]+$`, reject if `origin` has tag `vX.Y.Z`, run `npm version --no-git-tag-version --allow-same-version`, rewrite CHANGELOG heading to `## [vX.Y.Z] - <today>`, commit + tag + push as `github-actions[bot]`.

Outputs: `version`, `tag`.

### `publish`

Environment: `npm-publish`. Permissions: `contents: write`, `id-token: write`. Checks out `prepare.outputs.tag`. `npm install -g npm@latest` (Trusted Publishing needs npm ≥ 11.5.1). `npm ci`. `npm run typecheck`. Probes `npm view @blackbelt-technology/pi-flows@<version>`. If found: skip. Else: `npm publish --provenance --access public`. No `NPM_TOKEN` — OIDC.

### `github-release`

Runs iff `publish.result == 'success'`. Checks out tag. `awk` extracts `## [vX.Y.Z]` block from `CHANGELOG.md` to `release-notes.md`. Empty/missing → fallback to GitHub-generated notes. `softprops/action-gh-release@v2` creates Release with `draft: true`.

## Before the first release

One-time setup. Both required.

1. **npm Trusted Publisher.** npmjs.com → `@blackbelt-technology/pi-flows` settings → add Trusted Publisher:

   | Field | Value |
   |---|---|
   | Repository | `BlackBeltTechnology/pi-flows` |
   | Workflow filename | `publish.yml` |
   | Environment | `npm-publish` |

2. **GitHub environment `npm-publish`.** Settings → Environments → New environment → `npm-publish`. Optional: required-reviewer rule = manual approval gate.

Missing either → `publish` job fails at OIDC token exchange.

## Preparing the CHANGELOG

Add notes under `## [Unreleased]` before trigger. `prepare` rewrites heading in place to `## [vX.Y.Z] - YYYY-MM-DD`. Also accepts existing `## [X.Y.Z]` or `## [vX.Y.Z]` — normalises to canonical form.

No match → workflow warns. Release falls back to GitHub-generated notes.

## Idempotency

Re-run with already-published version: no-op. `publish` job runs `npm view @blackbelt-technology/pi-flows@<version>`; exit 0 → sets `skip=true` → publish step skipped. `github-release` still runs, recreates draft.

## Draft Release: manual publish

Release created with `draft: true`. After workflow finishes:

1. Open repo Releases page.
2. Review draft for new tag.
3. Edit body if needed.
4. Click `Publish release`.

Nothing public until click.

## Prereleases not supported

Version regex: `^[0-9]+\.[0-9]+\.[0-9]+$`. `0.2.2-rc.1`, `1.0.0-beta` rejected by `prepare` with `::error::`. Pushing `v0.2.2-rc.1` tag bypasses regex but downstream not designed for prereleases — do not.

## Reference: inputs and outputs

| Symbol | Source | Meaning |
|---|---|---|
| `inputs.version` | workflow_dispatch input | Version string, e.g. `0.2.2` |
| `prepare.outputs.version` | `prepare` job | Version without `v` prefix |
| `prepare.outputs.tag` | `prepare` job | Tag with `v` prefix, e.g. `v0.2.2` |
| `GITHUB_REF_NAME` | tag-push trigger | Tag name. Derives version on push. |

## Rollback

npm forbids unpublish after 24h. Within 24h: discouraged. Broken version shipped → bump-and-republish only path: cut `X.Y.Z+1` with fix, `npm deprecate @blackbelt-technology/pi-flows@X.Y.Z "broken, use X.Y.Z+1"`, note regression in `CHANGELOG.md`. No rollback button.
