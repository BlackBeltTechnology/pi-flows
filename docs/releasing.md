# Releasing pi-flows

Operator runbook for cutting a release of `@blackbelt-technology/pi-flows` to npm and GitHub.

The release pipeline lives in [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). This document explains how to drive it and what to do before the first run.

## Overview

The workflow has two trigger paths and three jobs:

| | |
|---|---|
| **Triggers** | `workflow_dispatch` (UI button) and tag push (`v*`) |
| **Jobs** | `prepare` → `publish` → `github-release` |
| **Registry** | npm, via Trusted Publishing (OIDC) with provenance |
| **GitHub Release** | Created as a **draft** — you publish it manually |

## Trigger paths

### 1. Workflow dispatch (recommended)

Open the GitHub Actions UI, pick the **Release** workflow, click **Run workflow**, and type the version string (e.g. `0.2.2`). The `prepare` job bumps `package.json`, dates the CHANGELOG heading, commits, tags `v0.2.2`, and pushes. The remaining jobs then run against the freshly-pushed tag.

### 2. Tag push

Bump `package.json`, edit `CHANGELOG.md`, commit, then:

```bash
git tag -a v0.2.2 -m v0.2.2
git push --follow-tags
```

The `prepare` job extracts the version from the tag (skipping the bump/commit/tag/push steps) and the rest of the pipeline fires.

## The three jobs

### `prepare`

Resolves the version. On tag push, it reads `GITHUB_REF_NAME` and strips the leading `v`. On `workflow_dispatch`, it validates the input against `^[0-9]+\.[0-9]+\.[0-9]+$`, checks that the tag does not already exist on `origin`, runs `npm version --no-git-tag-version`, rewrites the matching CHANGELOG heading to `## [vX.Y.Z] - <today>`, then commits, tags, and pushes.

### `publish`

Runs in the `npm-publish` GitHub environment. Checks out the tag, installs deps, runs `npm run typecheck` as a defence-in-depth gate, then checks whether `@blackbelt-technology/pi-flows@<version>` is already on npm via `npm view`. If it is, the publish step is skipped. Otherwise it runs `npm publish --provenance --access public` using a Trusted Publishing OIDC token (no `NPM_TOKEN` required).

### `github-release`

Runs only when `publish` succeeds. Extracts the `## [vX.Y.Z]` section out of `CHANGELOG.md` with an `awk` script and creates a **draft** GitHub Release via `softprops/action-gh-release`. If the CHANGELOG section is empty or missing, it falls back to GitHub-generated release notes.

## Before the first release

Two one-time setup steps are required:

1. **Configure npm Trusted Publisher.** On [npmjs.com](https://www.npmjs.com), open the `@blackbelt-technology/pi-flows` package settings, add a Trusted Publisher with:

   | Field | Value |
   |---|---|
   | Repository | `BlackBeltTechnology/pi-flows` |
   | Workflow filename | `publish.yml` |
   | Environment | `npm-publish` |

2. **Create the `npm-publish` GitHub environment.** Repo **Settings → Environments → New environment → `npm-publish`**. Add a required-reviewer rule there if you want a manual approval gate before every publish.

Without both, the `publish` job will fail when it tries to mint the OIDC token.

## Preparing the CHANGELOG

Put new release notes under `## [Unreleased]` in `CHANGELOG.md` before triggering the workflow. The `prepare` job rewrites that heading **in place** to `## [vX.Y.Z] - YYYY-MM-DD`. It also accepts an existing `## [X.Y.Z]` (bare or pre-tagged) heading and normalises it to the same canonical form.

If no matching heading is found the workflow emits a warning and falls back to GitHub-generated notes on the Release.

## Idempotency

Re-running the workflow with a version that already exists on npm is safe: the `publish` job calls `npm view @blackbelt-technology/pi-flows@<version>` and skips the publish step if the version is already published. The `github-release` job still runs and will (re-)create the draft Release.

## Draft Release: manual publish

The Release is created with `draft: true`. After the workflow finishes:

1. Open the repo's **Releases** page.
2. Review the draft for the new tag.
3. Edit the body if needed.
4. Click **Publish release**.

Nothing is announced or visible to non-maintainers until you click publish.

## Prereleases not supported

The version regex is `^[0-9]+\.[0-9]+\.[0-9]+$`. Strings like `0.2.2-rc.1` or `1.0.0-beta` are rejected by the `prepare` job with an `::error::` annotation. If you need a prerelease channel, extend the workflow — do not try to push a `v0.2.2-rc.1` tag, the publish job will not handle it correctly even if the prepare step were skipped.

## Reference: inputs and outputs

| Symbol | Source | Meaning |
|---|---|---|
| `inputs.version` | workflow_dispatch input | Version string typed by operator, e.g. `0.2.2` |
| `prepare.outputs.version` | `prepare` job | Resolved version without `v` prefix |
| `prepare.outputs.tag` | `prepare` job | Resolved tag including `v` prefix, e.g. `v0.2.2` |
| `GITHUB_REF_NAME` | tag-push trigger | Tag name, used to derive version on push |

## Rollback

You cannot unpublish from npm after 24 hours, and even within 24 hours unpublish is discouraged. If a broken version ships, the only realistic recourse is to **bump and republish**: cut `X.Y.Z+1` with the fix, deprecate the broken version on npm (`npm deprecate @blackbelt-technology/pi-flows@X.Y.Z "broken, use X.Y.Z+1"`), and note the regression in `CHANGELOG.md`. There is no rollback button.
