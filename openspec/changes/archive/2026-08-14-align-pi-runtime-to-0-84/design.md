## Context

`spawnAgent` (in `extensions/flow-engine/execution.ts`) constructs each subagent
session by calling the pi SDK's `createAgentSession(...)`. The pin bump to
`0.84.1` surfaces a breaking change first introduced in SDK `0.81.0`:

> Replaced the SDK's `CreateAgentSessionOptions.authStorage` and `modelRegistry`
> options with the async `modelRuntime` option. `AuthStorage` and its storage
> backends are no longer exported; use `ModelRuntime` (or a custom pi-ai
> `CredentialStore`), or `readStoredCredential()` for one-off reads of auth.json.

Measured evidence (this repo, this machine):

| Runtime | `tsc --noEmit` | `npm test` |
|---|---|---|
| `0.80.2` (baseline) | exit 0 | 349 passed / 349 |
| `0.84.1` (target)   | exit 2, 3 errors | 17 failed / 332 passed |

The three `tsc` errors are: `AuthStorage` no longer exported; the `resourceLoader`
literal missing `getSystemPromptSource` + `getAppendSystemPromptSources`; and
`authStorage` not assignable to `CreateAgentSessionOptions`.

## Goals

- Build green (`tsc` exit 0) and test green (≥ 349/349) against `0.84.1`.
- Keep the flow/agent authoring surface unchanged.
- Pin the peer floor to the version actually built and tested against.

## Decisions

### Pin floor = `^0.84.1` for the three pi peers
Applied in both `peerDependencies` and `devDependencies`, matching the existing
`dashboard-event-emission` rule: pin to the version present in `node_modules/` at
the time of the change, in caret form. `@sinclair/typebox` is not a pi-namespace
peer and is unaffected — it stays `^0.34.49`.

### `ResourceLoader` gains the two system-prompt-source accessors
The 0.84 `ResourceLoader` interface requires `getSystemPromptSource(): { path } |
undefined` and `getAppendSystemPromptSources(): Array<{ path }>`. `spawnAgent`
builds its prompt entirely in-memory (no on-disk prompt file), so both accessors
report "no source": `getSystemPromptSource` returns `undefined` and
`getAppendSystemPromptSources` returns `[]`. This preserves the existing behaviour
(the SDK builds the default system prompt and appends our agent prompt) while
satisfying the interface.

### Model/auth via `modelRuntime`, replacing `authStorage` + `modelRegistry`
The removed options are dropped from the `createAgentSession` call. Because the
model is already resolved and passed explicitly (`model:`) and the faux provider
registers into pi-ai's global provider registry, the session's `modelRuntime` is
supplied as an optional pass-through (`options.modelRuntime`, forwarded only when
present) — when omitted the SDK builds its default disk-backed runtime, which is
the correct production behaviour and is inert for the zero-network faux tests.
The internal `modelRegistry` handle stays available to `resolveModel` (model-role
resolution reads `pi.modelRegistry`); only the removed *session-bootstrap* options
are dropped.

## Risks / Trade-offs

- **Faux tests exercise the streaming path without a real runtime.** Mitigation:
  the faux provider lives in pi-ai's global registry and the model is passed
  explicitly, so no `modelRuntime` credential resolution is required; the suites
  returning to 349/349 is the gate proving this.

## Migration

None for downstream flow/agent authors — no authoring surface changes. Consumers
resolving the peer must have `0.84.1`+ installed, which the pin now enforces.
