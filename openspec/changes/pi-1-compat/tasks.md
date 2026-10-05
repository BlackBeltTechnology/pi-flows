## 1. Failing test first

- [x] 1.1 Add `__tests__/package-manifest.test.ts` asserting the spec: the three pi peers equal `>=0.84.1 <2.0.0`, `semver.satisfies` passes for 0.84.1, 0.86.1, 1.0.2 and fails for 2.0.0, `typebox` is a peer satisfied by 1.3.7 and 1.3.27, and `@sinclair/typebox` is absent from dependencies/peerDependencies; verify it FAILS against current `package.json`

## 2. Declarations

- [x] 2.1 In `package.json` set peers pi-ai / pi-coding-agent / pi-tui to `>=0.84.1 <2.0.0`, replace peer `@sinclair/typebox` with `typebox ^1.3.7`; verify task 1.1 test passes
- [x] 2.2 Bump devDependencies pi-ai / pi-coding-agent / pi-tui to `^1.0.2`, replace dev `@sinclair/typebox` with `typebox ^1.3.27`, run `npm install`; verify `npm ls typebox @earendil-works/pi-coding-agent` shows 1.3.x / 1.0.2 with no peer errors

## 3. Imports

- [x] 3.1 Rewrite `import { Type } from "@sinclair/typebox"` to `"typebox"` in `flow-write.ts`, `flow-agents.ts`, `ask-user.ts`, `guard.ts`, `flow-context/index.ts`; verify `grep -rn "@sinclair/typebox" extensions` returns nothing
- [x] 3.2 Rewrite `@sinclair/typebox/value` to `typebox/value` in `finish-retry.test.ts` and `output-validation.test.ts`; verify `grep -rn "@sinclair/typebox" __tests__` returns nothing

## 4. Green gate

- [x] 4.1 Run `npm run typecheck` and fix any pi 1.0.2 / typebox type breakages (check the hand-built `ResourceLoader` in `execution.ts` first); verify exit 0
- [x] 4.2 Run `npm test` and fix any `Value.Check` / `Value.Errors` behaviour differences in the validation suites; verify all suites pass
- [x] 4.3 Run `npm run lint`; verify exit 0
- [x] 4.4 Smoke test: `pi install /path/to/pi-flows` on a pi 1.0.2 host, run `/flows`; verify the extension loads and lists flows without errors

## 5. Release

- [x] 5.1 Bump `version` to `0.6.0` and add a CHANGELOG `0.6.0` section noting pi 1.x support (range widened to `>=0.84.1 <2.0.0`) and the switch to `typebox`; verify `npm pack --dry-run` shows 0.6.0
- [x] 5.2 Doubt-driven review of the peer-range change before publishing; verify findings resolved
- [ ] 5.3 Trigger the `Release` workflow with version `0.6.0` (per `docs/releasing.md`); verify `npm view @blackbelt-technology/pi-flows version` returns `0.6.0`
