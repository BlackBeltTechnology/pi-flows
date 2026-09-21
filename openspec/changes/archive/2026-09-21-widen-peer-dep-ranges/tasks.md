## 1. Edit the manifest

- [x] 1.1 In `package.json`, set each of the three peers to `>=0.84.1 <1.0.0`: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (no caret form).
- [x] 1.2 In `package.json` `devDependencies`, bump the same three `@earendil-works/*` packages to `^0.86.1`.
- [x] 1.3 Bump `package.json` `version` from `0.4.0` to `0.5.0`.
- [x] 1.4 Add a `0.5.0` entry to `CHANGELOG.md` describing the widened peer ranges and the devDep/host-line bump.

## 2. Validate the untested combination (the gate)

- [x] 2.1 Regenerated the lockfile with `npm install` (added scope: `npm ci` requires lock in sync; approved) so the bumped `^0.86.1` devDeps resolve — pi-ai/pca/pi-tui/pi-telemetry now at 0.86.1; `npm ci --dry-run` clean.
- [x] 2.2 Ran `npm test | tee /tmp/pi-flows-test.log` — 351/351 pass. The gate first went RED on the HIGH risk (`faux-skills-injection`: 0.86 `Context`→`TranscriptContext` removed `context.systemPrompt`); fixed the faux capture helper to read via `getCurrentSystemPrompt(context.messages)`.
- [x] 2.3 Ran `npm run typecheck` (no `build` script — no-compile pi-package; typecheck+lint is the real gate) — first RED on the MED risk (`testing.ts:231`, `ToolCall.arguments` tightened to `JsonObject`); fixed `scriptToolThenFinish` param `Record<string,unknown>`→`JsonObject`. Now clean; lint 0 errors.
- [x] 2.4 Gate ended green; both surfaced regressions (HIGH + MED) triaged against `design.md` and resolved with minimal faux-harness adaptations. Logs: `/tmp/pi-flows-{test,typecheck,gate-final}.log`.

## 3. Verify the peer-range contract

- [x] 3.1 Confirmed via `semver.satisfies`: `>=0.84.1 <1.0.0` accepts `0.84.1`/`0.85.1`/`0.86.1` and rejects `1.0.0`, matching the `package-manifest` spec scenarios.

## 4. Spec sync

- [x] 4.1 (archive/ship): `openspec archive` syncs the `package-manifest` delta ("Declares supported peer version range") into `openspec/specs/package-manifest/spec.md` at ship time; syncing during apply would double-apply at archive. `openspec validate widen-peer-dep-ranges` already passes.
