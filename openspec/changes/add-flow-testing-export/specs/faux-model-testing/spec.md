# faux-model-testing delta

## ADDED Requirements

### Requirement: Faux harness is a published, consumable module

The faux-model harness SHALL be shipped as `extensions/flow-engine/testing.ts` and SHALL be importable by an installed consumer through the `@blackbelt-technology/pi-flows/testing` subpath export. The in-repo test suites SHALL consume the same module (directly or via a thin `__tests__/faux-harness.ts` re-export) so that the published surface and the surface the suites exercise are identical.

The published surface SHALL expose, at minimum: `runFauxFlow`, `spawnFaux`, `runFaux`, `scriptFinish`, `scriptToolThenFinish`, `scriptError`, `scriptSlowText`, `makeAgent`, `lastUserText`, and `parseFlowYamlString`, plus the supporting types (`FinishArgs`, `FauxResponseStep`, `AgentConfig`, `FlowConfig`, `FlowResult`, `AgentResult`).

The published surface SHALL NOT export the engine entrypoints `runFlow` or `spawnAgent` directly; the faux runners SHALL wrap them internally, so the committed public API is the scripted-faux-testing semantics rather than the engine's internal signatures.

#### Scenario: Downstream import surfaces the runner and verbs

- **WHEN** a downstream package imports `{ runFauxFlow, scriptFinish, parseFlowYamlString }` from `@blackbelt-technology/pi-flows/testing`
- **THEN** all three SHALL be defined functions, and `runFauxFlow` SHALL drive the real `runFlow` DAG executor against a scripted faux provider exactly as the in-repo suites do.

#### Scenario: In-repo suites use the shipped module

- **WHEN** the existing `__tests__/faux-*.test.ts` suites run
- **THEN** they SHALL resolve the harness from the shipped `extensions/flow-engine/testing.ts` (directly or via a re-export shim) and SHALL pass unchanged.

### Requirement: Nested-pi-ai registration works across install layouts

The harness SHALL register the faux api into the exact `@earendil-works/pi-ai` module instance that `@earendil-works/pi-coding-agent` resolves streams through, when pi-flows is consumed as an **installed dependency** — not only in the dev-clone layout. Resolution SHALL anchor to pi-coding-agent's real install location (e.g. via `createRequire(...).resolve("@earendil-works/pi-coding-agent/package.json")`) and follow the dependency edge, rather than relying solely on an upward directory walk.

Resolution SHALL succeed under npm (deduped/hoisted), npm (version-pinned nested), and pnpm (symlink) layouts. When no `pi-ai/compat.js` instance can be located, the harness SHALL throw a clear error that names the resolution problem, rather than allowing the downstream "No API provider registered" failure to surface from deep inside a faux run.

#### Scenario: Hoisted layout registers into the shared instance

- **WHEN** pi-flows and pi-coding-agent are installed such that a single deduped `@earendil-works/pi-ai` copy is shared
- **THEN** the harness SHALL register the faux api into that shared instance and a faux run SHALL complete without "No API provider registered".

#### Scenario: Nested layout registers into pi-coding-agent's copy

- **WHEN** pi-coding-agent carries its own nested `@earendil-works/pi-ai` (version-pinned, not deduped)
- **THEN** the harness SHALL register into that nested `compat.js` — the same instance `createAgentSession` uses — and a faux run SHALL complete.

#### Scenario: Resolution failure is actionable

- **WHEN** no `pi-ai/compat.js` belonging to pi-coding-agent can be resolved
- **THEN** the harness SHALL throw an error that names the nested-pi-ai resolution problem before any faux stream is attempted.
