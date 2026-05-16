# release-pipeline Specification

## Purpose
TBD - created by archiving change add-ci-and-release. Update Purpose after archive.
## Requirements
### Requirement: Continuous integration runs on every PR and develop push

The repository SHALL include `.github/workflows/ci.yml` that runs on `push` to `develop` and on every `pull_request` regardless of target branch. The workflow SHALL run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm test` on a Node version matrix of `[20, 22, 24]`. All matrix legs SHALL pass for the workflow to be green.

#### Scenario: PR with broken test fails CI

- **WHEN** a pull request is opened that introduces a failing vitest case
- **THEN** the `ci` workflow SHALL fail
- **AND** the failure SHALL appear on the pull request's checks summary
- **AND** the failure SHALL be reported on at least one of `node-version: 20`, `22`, `24` (whichever exposes the regression).

#### Scenario: PR with type error fails CI

- **WHEN** a pull request introduces TypeScript code that fails `tsc --noEmit`
- **THEN** the `ci` workflow's `typecheck` step SHALL fail
- **AND** the workflow SHALL NOT proceed to the `test` step on that matrix leg.

#### Scenario: PR with lint violation fails CI

- **WHEN** a pull request introduces code that ESLint flags as an error (not just a warning)
- **THEN** the `ci` workflow's `lint` step SHALL fail
- **AND** the workflow SHALL NOT proceed to `typecheck` on that matrix leg.

#### Scenario: Push to develop runs CI

- **WHEN** a commit is pushed directly to `develop` (e.g. after a merge)
- **THEN** the `ci` workflow SHALL run with the same matrix and steps.

### Requirement: Release workflow accepts tag-push and workflow_dispatch

The repository SHALL include `.github/workflows/publish.yml` triggered by `push: { tags: ['v*'] }` and by `workflow_dispatch` with a required string input `version`. The workflow SHALL contain three jobs in this order: `prepare`, `publish`, `github-release`.

#### Scenario: Tag push triggers release

- **WHEN** a tag matching `v*` (e.g. `v0.2.2`) is pushed to origin
- **THEN** the `prepare` job SHALL resolve `version=0.2.2` and `tag=v0.2.2` from `GITHUB_REF_NAME`
- **AND** SHALL NOT bump `package.json` (the bump is assumed to already be on the tagged commit).

#### Scenario: workflow_dispatch with valid version triggers release

- **WHEN** an operator invokes `workflow_dispatch` with `version: "0.2.2"`
- **THEN** the `prepare` job SHALL validate the input matches `^[0-9]+\.[0-9]+\.[0-9]+$`
- **AND** SHALL run `npm version 0.2.2 --no-git-tag-version --allow-same-version`
- **AND** SHALL replace `## [Unreleased]` (or an undated `## [0.2.2]` row) in `CHANGELOG.md` with `## [v0.2.2] - <today's ISO date>`
- **AND** SHALL commit, tag `v0.2.2`, and push to `develop`.

#### Scenario: workflow_dispatch with invalid version fails fast

- **WHEN** an operator invokes `workflow_dispatch` with `version: "not-a-version"` or `version: "v0.2.2"` (leading `v`) or `version: "0.2.2-rc.1"` (prerelease, out of scope)
- **THEN** the `prepare` job SHALL fail at the version-validation step with a clear error
- **AND** the `publish` and `github-release` jobs SHALL NOT run.

#### Scenario: workflow_dispatch with already-existing tag fails fast

- **WHEN** an operator invokes `workflow_dispatch` with a `version` whose corresponding `v<version>` tag already exists on origin
- **THEN** the `prepare` job SHALL fail before bumping any files.

### Requirement: Publish uses npm Trusted Publishing with provenance

The `publish` job SHALL publish to npm using OIDC-based Trusted Publishing. The job SHALL declare `permissions: { contents: write, id-token: write }`. The job SHALL run in the GitHub environment named `npm-publish`. The `npm publish` invocation SHALL include `--provenance --access public`.

#### Scenario: Successful publish attests provenance

- **WHEN** the `publish` job runs to completion for `@blackbelt-technology/pi-flows@<version>`
- **THEN** the npm registry SHALL serve a provenance attestation for that version
- **AND** the package page at `https://www.npmjs.com/package/@blackbelt-technology/pi-flows/v/<version>` SHALL display the "Provenance" badge.

#### Scenario: Re-running a published version is a no-op

- **WHEN** the `publish` job runs for a `<version>` that is already on the registry
- **THEN** the idempotency check SHALL detect it via `npm view @blackbelt-technology/pi-flows@<version> version`
- **AND** the job SHALL exit 0 without invoking `npm publish`
- **AND** the `github-release` job SHALL still run (so a partially-failed prior run can finish creating the Release).

#### Scenario: Environment gate blocks unauthorised publish

- **WHEN** the `npm-publish` GitHub environment has a required-reviewer rule configured
- **AND** the `publish` job is queued
- **THEN** the job SHALL pause until a reviewer approves it via the GitHub Actions UI
- **AND** the `prepare` job SHALL have already completed (so the version bump and tag are in place even if publishing is rejected).

### Requirement: GitHub Release is drafted from CHANGELOG section

The `github-release` job SHALL extract the section between `## [v<version>]` and the next `## [` heading from `CHANGELOG.md` using `awk`, write it to `release-notes.md`, and create a draft GitHub Release via `softprops/action-gh-release@v2` with `body_path: release-notes.md` and `tag_name: <prepare.outputs.tag>`. The Release SHALL be marked `draft: true`. No assets SHALL be attached (`files:` is omitted).

#### Scenario: CHANGELOG section becomes release body

- **GIVEN** `CHANGELOG.md` contains a `## [v0.2.2] - 2026-05-16` heading followed by bullet-list release notes
- **WHEN** the `github-release` job runs after a successful publish of `0.2.2`
- **THEN** a draft Release with `tag_name: v0.2.2` SHALL exist on `github.com/BlackBeltTechnology/pi-flows/releases`
- **AND** its body SHALL be the lines between that heading and the next `## [` heading (or EOF).

#### Scenario: Missing CHANGELOG section falls back

- **WHEN** the `github-release` job runs and the awk extraction produces an empty `release-notes.md` (no matching heading, or empty section)
- **THEN** the job SHALL fall back to writing a one-line body pointing at the CHANGELOG.md file
- **AND** SHALL set `generate_release_notes: true` so GitHub auto-generates a commit-based body
- **AND** the workflow SHALL still succeed.

#### Scenario: Release stays draft until operator publishes

- **WHEN** the `github-release` job creates the Release
- **THEN** the Release SHALL be in `draft` state on github.com
- **AND** SHALL NOT appear in the public Releases list
- **AND** SHALL NOT trigger any `release: { types: [published] }` downstream workflows
- **AND** an operator SHALL manually click "Publish release" after reviewing the body.

### Requirement: Publish workflow does not include scope outside pi-flows shape

The `publish.yml` workflow SHALL NOT include an electron build job, a site sync job, a workspace-aware version-sync script, or a release-notes footer file. Adding any of these is a separate proposal.

#### Scenario: Workflow inspection confirms scope

- **WHEN** `.github/workflows/publish.yml` is reviewed
- **THEN** it SHALL contain exactly the three jobs `prepare`, `publish`, `github-release`
- **AND** SHALL NOT reference `electron-builder`, `softprops/action-gh-release` with `files:`, `npm-workspaces` flags, `scripts/sync-versions.js`, or `.github/release-notes-footer.md`.

