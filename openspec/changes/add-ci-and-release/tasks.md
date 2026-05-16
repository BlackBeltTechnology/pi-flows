# Tasks

## Pre-flight (external — verify before workflow runs)

- [ ] 1. Confirm npm Trusted Publisher is configured for `@blackbelt-technology/pi-flows` on npmjs.com (org → package → "Publishing access" → trusted publisher = `BlackBeltTechnology/pi-flows` GitHub repo, workflow filename = `publish.yml`, environment = `npm-publish`).
- [ ] 2. Create GitHub repository environment named `npm-publish` (Settings → Environments → New environment). Leave protection rules empty for now; a required-reviewer rule can be added later without touching workflow YAML.

## Tooling scaffolding

- [x] 3. Add `tsconfig.json` at repo root targeting the same TS dialect pi-coding-agent uses (`ESNext` module, `bundler` resolution, `strict: true`, `noEmit: true`, `include: ["extensions", "__tests__"]`).
- [x] 3a. Fix `ToolDefinition` missing `label` field across `extensions/flow-engine/tools/`: `agent-catalog.ts`, `agent-write.ts`, `ask-user.ts`, `flow-write.ts`, `skill-read.ts` (+ any others surfaced).
- [x] 3b. Fix `AgentResult` shape drift in `extensions/flow-engine/flow-execution.ts` (3 sites) — add `success`, `exitCode`, `duration`, `tokens` fields to error-path return objects.
- [x] 3c. Fix `ExtensionUIContext` drift in `extensions/flow-engine/execution.ts:663` — add `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `addAutocompleteProvider`, `getEditorComponent` to the stub (no-op implementations).
- [x] 3d. Fix `AgentStep.model` access in `extensions/flow-dashboard/flow-preview-overlay.ts:86` — read `model` from the agent frontmatter via the resolved agent, not the step.
- [x] 3e. Fix `FlowStep.blockedBy` narrowing in `extensions/flow-workspace/index.ts:36` — guard with a type check before accessing.
- [x] 3f. Fix the remaining smaller drifts: `architect-widget.ts` `onAssistantText`, `execution.ts` `getPathMetadata`, `flow-manager.ts:112` `AskUserResult.answer` union, `index.ts:265` arity, `ask-user.ts:39/50` arity, `anthropic-messages-adapter.ts:33` missing `@pi/anthropic-messages` module (likely needs optional/lazy import).
- [x] 3g. Re-run `npx tsc --noEmit` — clean exit (0 errors).
- [x] 4. Add ESLint config (`eslint.config.js` flat-config form for ESLint 9+). Minimal: `@eslint/js` recommended + `typescript-eslint` recommended, no stylistic plugins. Tune to silence false positives in existing code rather than mass-refactoring (per Surgical Changes rule in `AGENTS.md`).
- [x] 5. Add `lint`, `typecheck` scripts to `package.json`. Add `eslint`, `typescript`, `typescript-eslint`, `@eslint/js` to `devDependencies`. Run all three (`npm run lint`, `npm run typecheck`, `npm test`) locally; commit lockfile.

## CI workflow

- [x] 6. Add `.github/workflows/ci.yml`. Triggers: `push: { branches: [develop] }`, `pull_request: {}` (no branch filter — catches PRs to any target). Matrix on `node-version: [20, 22, 24]`. Steps: checkout → setup-node with `cache: npm` → `npm ci` → `npm run lint` → `npm run typecheck` → `npm test`.
- [ ] 7. Open a no-op PR against `develop`; verify all three Node-version jobs pass.

## Release workflow — prepare job

- [x] 8. Add `.github/workflows/publish.yml` with `on: { push: { tags: ['v*'] }, workflow_dispatch: { inputs: { version: { type: string, required: true } } } }`.
- [x] 9. Implement `prepare` job:
  - `permissions: { contents: write }`.
  - Resolve version: on tag-push read `GITHUB_REF_NAME`; on dispatch read `inputs.version`, validate semver `^[0-9]+\.[0-9]+\.[0-9]+$` (no prerelease segment — out of scope).
  - On dispatch only: `npm version <version> --no-git-tag-version --allow-same-version`, then update `CHANGELOG.md` by replacing `## [Unreleased]` (or `## [<version>]` if dated-but-not-tagged, like the existing `0.2.0` / `0.2.1` rows) with `## [v<version>] - <today>`. Commit + tag + push to `develop`.
  - Outputs: `version`, `tag`.

## Release workflow — publish job

- [x] 10. Implement `publish` job:
  - `needs: prepare`.
  - `environment: npm-publish` (gates on the GH environment created in step 2).
  - `permissions: { contents: write, id-token: write }` (id-token for OIDC).
  - Checkout `ref: ${{ needs.prepare.outputs.tag }}`.
  - `setup-node` with `node-version: 24`, `registry-url: https://registry.npmjs.org`.
  - `npm install -g npm@latest` (Trusted Publishing requires npm ≥ 11.5.1).
  - `npm ci`, `npm run typecheck` (defence-in-depth — don't publish a broken build even though CI already ran).
  - Idempotency check: `if npm view @blackbelt-technology/pi-flows@<version> version >/dev/null 2>&1; then echo "already published"; exit 0; fi`.
  - `npm publish --provenance --access public`.

## Release workflow — github-release job

- [x] 11. Implement `github-release` job:
  - `needs: [prepare, publish]`, `if: always() && needs.publish.result == 'success'`.
  - `permissions: { contents: write }`.
  - Checkout `ref: ${{ needs.prepare.outputs.tag }}`.
  - Extract CHANGELOG section with the same awk one-liner the dashboard uses (matches `## [v<version>]` heading, stops at next `## [`).
  - `softprops/action-gh-release@v2` with `tag_name`, `body_path: release-notes.md`, `draft: true`. No `files:` (no assets).

## Smoke test

- [ ] 12. Cut a test release: `workflow_dispatch` with `version: 0.2.2`. Verify the run: prepare commits + tags + pushes, publish lands on npm with `provenance: true` visible at `https://www.npmjs.com/package/@blackbelt-technology/pi-flows/v/0.2.2`, github-release creates a draft Release with the CHANGELOG body.
- [ ] 13. Retroactively tag `0.2.0` and `0.2.1` locally and `git push --tags` — only the new tag-push path fires for those (no version bump, since CHANGELOG entries already exist), publishing them with provenance for historical hygiene. **Skip if either version is already published to npm** — the idempotency check in step 10 will no-op cleanly.

## Documentation

- [x] 14. Add CI status badge to top of `README.md`: `![CI](https://github.com/BlackBeltTechnology/pi-flows/actions/workflows/ci.yml/badge.svg?branch=develop)`.
- [x] 15. Add a "Releasing" section to `README.md` (or a new `docs/releasing.md` + `agent-docs/releasing.md` mirror — caveman style for the agent-docs version, per AGENTS.md). Covers: tag-push path vs workflow_dispatch path, the `npm-publish` environment gate, what to put in CHANGELOG before releasing.
- [x] 16. Update `AGENTS.md` "Running, Testing, Deploying" table: change the `Publish` row from manual `npm publish` to point at the workflow, add a `Lint` and `Typecheck` row, add a `CI` row pointing at the CI workflow.
- [x] 17. CHANGELOG entry under `## [Unreleased]` documenting that CI + release pipeline landed.

## Validate

- [x] 18. `cd /Users/robson/Project/pi-flows && openspec validate add-ci-and-release` — passes with zero errors.
