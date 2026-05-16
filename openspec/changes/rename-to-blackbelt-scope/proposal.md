# Rename to `@blackbelt-technology/pi-flows` for npm publish

> Retrospective proposal — captures the intent of commit `0c3bb8e` ("chore(npm): rename to @blackbelt-technology/pi-flows, prep for npm publish (v0.2.1)") after the fact.

## Why

`pi-flows` was published to git but never to npm. The unscoped name `pi-flows` is not owned by us on the npm registry, and unscoped names are squat-prone and convey no organisational ownership. Consumers that want to install the package via a normal `npm install` (instead of cloning the repo or symlinking from a worktree) currently have no path forward.

At the same time, the package manifest was missing the publish-time hygiene fields that npm and downstream tooling expect:

- no `publishConfig.access` — required for first-time publish of a scoped package as public (npm defaults scoped packages to restricted).
- no `repository` field — breaks "View repository" links on npmjs.com and several discovery tools.
- no `files` allowlist — `npm publish` would tar up the entire working tree (including `__tests__/`, `research/`, `openspec/`, `.pi/`) and ship it to every consumer.

The scope `@blackbelt-technology` matches the GitHub org (`BlackBeltTechnology/pi-flows`) that already hosts the source, so name, scope, and repo URL all line up.

## What changes

`pi-flows/package.json`:

- Rename `"name"` from `"pi-flows"` to `"@blackbelt-technology/pi-flows"`.
- Bump `"version"` from `0.2.0` → `0.2.1` (publish-prep, no behavioural change).
- Add `"publishConfig": { "access": "public" }` so the first publish of the scoped name actually goes public instead of being rejected as a private-registry push.
- Add `"repository": { "type": "git", "url": "git+https://github.com/BlackBeltTechnology/pi-flows.git" }`.
- Add a `"files"` allowlist limited to the directories consumers actually need: `extensions/`, `agents/`, `README.md`, `CHANGELOG.md`, `LICENSE`.

`pi.extensions`, `main`, `exports`, and `type` are intentionally untouched — the Node-resolvable entry contract from the `add-node-resolvable-entry` change still holds.

## Impact

- **Affected specs:** new `npm-publish` capability locking in the publish-time manifest contract (scoped name, `publishConfig.access`, `repository`, `files` allowlist).
- **Affected code:** `pi-flows/package.json` only.
- **Affected consumers:**
  - Anyone importing the package by name MUST now write `@blackbelt-technology/pi-flows` instead of `pi-flows`. This is a breaking rename at the import-specifier level, but since the package was never on npm, the only existing consumers are in-tree (pi-coding-agent settings pointing at local paths, not bare specifiers) and the sibling `pi-agent-dashboard` (which resolves via local path too).
  - Future `npm install @blackbelt-technology/pi-flows` consumers receive a slim tarball containing only `extensions/`, `agents/`, and the doc files.
- **Backward compatibility:** the old name `pi-flows` is NOT aliased. Any tooling that hard-codes the string `"pi-flows"` as a bare import specifier will break and must be updated.
- **Out of scope:**
  - Actually running `npm publish` (this proposal only locks the manifest; the publish itself is an operational task).
  - Compiling TypeScript to JS before publish — the published tarball still ships `.ts` and relies on the consumer's jiti loader, same as today.
  - Renaming the GitHub repo or org.
