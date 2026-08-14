## Why

The pinned pi runtime peers (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`)
have advanced to `0.84.1`, which carries a breaking SDK surface change to the
subagent bootstrap path. Measured against a green `0.80.2` baseline (typecheck
exit 0, `npm test` 349/349), building `pi-flows` against `0.84.1` regresses to
`tsc` exit 2 (3 errors) and `npm test` 17 failed / 332 passed — every faux spawn
that reaches `createAgentSession` fails because the SDK now:

1. no longer exports the `AuthStorage` type,
2. requires `ResourceLoader` implementations to provide `getSystemPromptSource()`
   and `getAppendSystemPromptSources()`, and
3. replaced the `authStorage` and `modelRegistry` session-bootstrap options with a
   single `modelRuntime` option (per the SDK 0.81.0 breaking change).

`pi-flows`'s `spawnAgent` still targets the pre-0.81 shape, so agent sessions
fail to construct at runtime. This change realigns the engine to the current SDK
so subagent spawn works again and the peer floor reflects the version this repo
is actually built and tested against.

## What Changes

- **Bump the pinned pi peer floor to `^0.84.1`** for `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`, in BOTH `peerDependencies`
  and `devDependencies`. `@sinclair/typebox` is unaffected and stays `^0.34.49`.
- **Realign `spawnAgent`'s `createAgentSession` bootstrap** to the 0.84 SDK:
  - drop the removed `AuthStorage` import,
  - extend the in-line `ResourceLoader` with `getSystemPromptSource()` and
    `getAppendSystemPromptSources()`,
  - supply model/auth to the session via the `modelRuntime` option instead of the
    removed `authStorage` / `modelRegistry` options.
- **Restore the gate to its measured floor:** `tsc` exit 0, `npm test` 349/349.

## Capabilities

### Modified Capabilities
- `subagent-spawn`: the `spawnAgent` → `createAgentSession` bootstrap contract is
  updated for the current pi SDK — the supplied `ResourceLoader` implements the
  full interface (including the system-prompt-source accessors) and model/auth is
  provided through the `modelRuntime` option.
- `dashboard-event-emission`: the peer-dependency pin requirement is updated so the
  pinned floor for the three pi-namespace peers reflects the version this repo is
  built and tested against (`^0.84.1`).

## Impact

- **Code:** `extensions/flow-engine/execution.ts` (import list, the `resourceLoader`
  literal, and the `createAgentSession({ ... })` option object). No change to the
  public flow/agent authoring surface.
- **Manifest:** `package.json` `peerDependencies` + `devDependencies` pins.
- **Tests:** the faux spawn suites return to green (349/349); a focused regression
  test asserts a faux spawn constructs and completes successfully under the current
  runtime.
- **Out of scope:** cutting/publishing a release. This change lands the alignment
  only; the release is handled separately.
