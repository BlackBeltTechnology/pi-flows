# Tasks — align-pi-runtime-to-0-84

## 1. Test-first (write failing, verify red)
- [x] 1.1 Add a focused regression test (`__tests__/pi-runtime-alignment.test.ts`) that
      spawns a faux, zero-network agent via the real `spawnAgent`/`spawnFaux` loop,
      scripts it to finish successfully, and asserts the outcome reports success
      (i.e. the session constructs — no session-creation error) under the current SDK.
- [x] 1.2 Run the test and confirm it FAILS against the `0.84.1` runtime before any
      implementation change (captures the regression the change fixes).

## 2. Implement — spawnAgent bootstrap alignment (`extensions/flow-engine/execution.ts`)
- [x] 2.1 Drop the removed `AuthStorage` import from the pi SDK type import.
- [x] 2.2 Extend the in-line `ResourceLoader` literal with `getSystemPromptSource()`
      (returns `undefined`) and `getAppendSystemPromptSources()` (returns `[]`).
- [x] 2.3 Replace the removed `authStorage` / `modelRegistry` session-bootstrap
      options on the `createAgentSession(...)` call with a forwarded optional
      `modelRuntime` (omit when absent). Keep `pi.modelRegistry` model-role
      resolution intact.

## 3. Manifest — peer floor bump (`package.json`)
- [x] 3.1 Set `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and
      `@earendil-works/pi-tui` to `^0.84.1` in `peerDependencies`.
- [x] 3.2 Mirror the same `^0.84.1` pins in `devDependencies`. Leave
      `@sinclair/typebox` at `^0.34.49`.

## 4. Changelog
- [x] 4.1 Add an `## [Unreleased]` section to `CHANGELOG.md` with the 0.4.0 release
      notes (runtime alignment + peer floor bump). Do NOT hand-bump the version in
      `package.json` — the release job rewrites the `[Unreleased]` heading.

## 5. Gate (all green, pasted as evidence)
- [x] 5.1 `npm run lint`
- [x] 5.2 `npm run typecheck` (returns to exit 0)
- [x] 5.3 `npm test` (≥ 349/349)
- [x] 5.4 `openspec validate align-pi-runtime-to-0-84 --strict`
