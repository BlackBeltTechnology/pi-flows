## Context

`spawnAgent` (`extensions/flow-engine/execution.ts`) resolves a `Model` object and hands it straight to `createAgentSession({ model, ... })`. The real agent loop — guard extension, finish latch, finish-retry stop-gate (`MAX_FINISH_RETRIES = 2`), tool dispatch, abort wiring, token accounting — runs entirely inside that session. Today no test drives it; all suites stub *around* it (`model-resolution`, `code-node-*`, `no-spawn-without-signal`, etc.).

`@earendil-works/pi-ai` ships `fauxProvider` (`providers/faux.ts`): a scripted-response provider. You queue `AssistantMessage`s (or factory fns) via `setResponses`/`appendResponses`; each `stream()` call shifts one off the queue and emits real streaming deltas (`text_*`, `thinking_*`, `toolcall_*`), usage with prefix-cache estimation, and honors `signal` for abort. Its `Model` object is registry-shaped and its auth resolver is a no-op (`async () => ({ auth: {} })`), so a faux session needs no network and no real credentials.

`SpawnOptions` already exposes the exact seams a test needs: `modelRegistry`, `resolvedModelId` (skips `resolveModel`), `authStorage`, and `signal`. No production refactor is required.

## Goals / Non-Goals

**Goals:**
- Drive the real `createAgentSession` loop deterministically, zero network.
- Cover the agent-loop capabilities no test reaches today: finish happy path, finish retry + latch, guard tool dispatch, unauthorized-tool block, abort mid-stream, soft-fail routing.
- Provide a thin, reusable harness so each test is a few lines of scripting.
- Exercise a couple of `runFlow` paths (multi-step output wiring, fork) end-to-end.

**Non-Goals:**
- Refactoring `spawnAgent`/`runFlow` for testability — use existing seams.
- Replacing existing seam tests.
- Real-provider/integration coverage.
- Exhaustive matrix of every step type (code-decision already has no model and is covered).

## Decisions

**D1 — Inject via `modelRegistry` stub + `resolvedModelId`, not via `model:resolve`.**
The harness builds a registry stub `{ find, getAll, authStorage }` backed by `faux.models` and passes `resolvedModelId: "faux/faux-1"` so `spawnAgent` skips `resolveModel` entirely. *Alternative:* register a `model:resolve` handler on a stub `pi.events`. Rejected for the default path — it couples every test to the resolution event and adds setup with no coverage gain (resolution already has its own suite). A single dedicated test MAY still drive `resolveModel` to confirm faux is resolvable, but the bulk use the direct seam.

**D2 — Scripted responses are the unit of a test.**
`fauxAssistantMessage([fauxToolCall("finish", {...})])` is the happy path; a 2-element queue `[bad-finish, good-finish]` exercises the retry/latch loop; `fauxAssistantMessage([], {stopReason:"error", errorMessage})` drives soft-fail. A `FauxResponseFactory` switching on `state.callCount` covers turn-dependent behavior. *Alternative:* a built-in echo factory. Rejected — faux has no echo; "echo" is just one factory recipe, not a primitive worth privileging.

**D3 — Multi-agent discriminator is the model id, not prompt text.**
For `runFlow` tests, register one faux model id per agent role (`models: [{id:"writer"},{id:"critic"}]`) or one provider per role; a factory branches on `model.id`. *Alternative:* inspect `context.systemPrompt` to detect the calling agent. Rejected — couples tests to prompt body text; the model id is a structural discriminator.

**D4 — The `mcp__flows__` prefix path needs an explicit `anthropic-messages` faux model.**
`toolPrefix` is set only when `model.api === "anthropic-messages"`; a default faux model (`api: "faux"`) calls plain `finish`. One test sets the faux model's `api` to `"anthropic-messages"` and asserts the prefixed `mcp__flows__finish` name flows through. Other tests use the default (unprefixed) api.

## Risks / Trade-offs

- **Harness drifts from `createAgentSession`'s real arg shape** → Mitigation: harness calls the real `spawnAgent`, not a reimplementation; if the SDK arg contract changes, these tests fail loudly (which is the point).
- **Finish schema gate trips the happy path** → Mitigation: the happy-path scripted finish carries a schema-valid `{status, summary, files, artifacts}`; a deliberately-malformed finish is reserved for the retry test.
- **Faux streaming timing flakiness in abort test** → Mitigation: use a low fixed `tokensPerSecond` and abort via the same `AbortSignal` `spawnAgent` already wires; assert on the `aborted` stopReason, not on wall-clock timing.
- **Over-coupling to faux internals** → Mitigation: confine all faux knowledge to `faux-harness.ts`; suites speak only in harness verbs (`scriptFinish`, `scriptToolThenFinish`, `scriptError`).

## Open Questions

- Should the `runFlow` smoke tests live in a separate file from the `spawnAgent` suites, or share the harness in one file? (Lean: share harness, split files by altitude.)
- Is a single `resolveModel`-through-faux test worth adding, or does the existing `model-resolution` suite already cover it? (Lean: skip — no new coverage.)
