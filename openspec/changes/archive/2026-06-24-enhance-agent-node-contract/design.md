# Design — Enhance the Agent Node Contract

## Context

`spawnAgent` (`extensions/flow-engine/execution.ts`) is the single chokepoint where a flow step becomes a live pi subagent session. Four weaknesses (see proposal) all converge here or in the parser/guard that feed it:

- Session creation is hard-coded to `SessionManager.inMemory()` (execution.ts:349).
- The finish tool schema is built in `guard.ts` (`createGuardExtension`, lines ~80-145); declared outputs become `Type.Optional(Type.String())`.
- Output extraction is a blind `String(finishParams[name])` (execution.ts:605-616).
- System-prompt preamble injection already exists via `options.preambleSections` (execution.ts:199-202), fed from `flow-execution.ts:560`.

Two retry loops already exist in `spawnAgent`:
- **Schema-validation fail** → `session.followUp(...)` (execution.ts:457-468), bounded by `MAX_FINISH_RETRIES = 2`.
- **No-finish-called** → `session.prompt(...)` reprompt (execution.ts:523-534).

The main session's `SessionManager` is captured at `flow-engine/index.ts:204` (`ctx.sessionManager`) but only used for persistence markers and orphan reconciliation — it is **not** threaded to `FlowManager → runFlow → spawnAgent`.

## Goals / Non-Goals

**Goals**
- Add `fork_session`, `context_files`, and output `type`/`pattern` to the agent frontmatter contract.
- Enforce declared outputs at the SDK schema level so malformed/missing outputs are rejected and retried deterministically.
- First test coverage for parser, finish-schema, and extraction.

**Non-Goals**
- The generic code node (separate change) — this change only guarantees the deterministic-output contract it will consume.
- Input typing/validation.
- A `required: false` per-output opt-out.
- Replacing the finish tool or the `<result>` fallback path.

## Decisions

### Decision 1: Outputs stay string-valued; `type`/`pattern` are content constraints

`typedOutputs` remains `Record<string, string>`. `type: number|boolean` does **not** change the extracted JS type — it constrains the *string content* (numeric string, `"true"`/`"false"`). `pattern` is a regex the string must match. This keeps every downstream consumer (`${{result.STEP.name}}` template expansion, dashboard, future code node) on a uniform string channel while still giving determinism.

Rationale: the user's driving case is "a code node needs a clean file path, the agent phrases it ten ways." A regex `pattern` solves that without a type-coercion layer. The output **name** carries the semantic contract; inputs therefore need no symmetric typing.

### Decision 2: Enforce via the TypeBox finish schema, not post-hoc validation

`guard.ts` builds the per-output finish params. Change:
- Declared outputs become **required** (`Type.String(...)` instead of `Type.Optional(Type.String(...))`).
- `pattern` → `Type.String({ pattern: <regex> })`.
- `type: number` → `Type.String({ pattern: "^-?\\d+(\\.\\d+)?$" })`; `type: boolean` → `Type.String({ pattern: "^(true|false)$" })`. (Kept as pattern-on-string to preserve the string channel.) An explicit `pattern` on a typed output is ANDed by composing the stricter regex, or the explicit `pattern` wins — see Decision 5.

The SDK validates the `finish` call against this schema and emits a `tool_execution_end` with `isError: true` on mismatch, which already triggers the followUp retry at execution.ts:457. No new validation code path is introduced; we only make the schema strict.

### Decision 3: `fork_session` uses `SessionManager.forkFrom`

When `fork_session: true`:
1. Thread the main `SessionManager` from `flow-engine/index.ts` → `FlowManager` (new `getSessionManager()` provider) → `runFlow` options → `spawnAgent` option.
2. In `spawnAgent`: `const file = mainSessionManager?.getSessionFile();`
   - If `file` is defined → `SessionManager.forkFrom(file, cwd)` and pass as `sessionManager`.
   - Else (in-memory / unpersisted main session) → fall back to `SessionManager.inMemory()` (current behavior) and emit a diagnostic.
3. The fork is a new child session file; agent writes land there, not in the operator's live leaf. The agent inherits the operator's full conversation data.

Rationale: `forkFrom` is pi's own fork primitive; reusing it keeps parent/child session lineage consistent with `/fork`.

### Decision 4: `context_files` reuses the existing preamble injection

`context_files: [path, …]` is parsed into `AgentConfig.context_files`. At spawn, each path is resolved relative to `cwd`, read, and pushed onto `preambleSections` as `## Context: <path>\n\n<contents>`. Missing/unreadable files are skipped with a diagnostic (non-fatal). This reuses execution.ts:199-202 verbatim — no new injection mechanism. `AGENTS.md` is just a path a user can list; there is no dedicated boolean flag.

### Decision 5: Conflict resolution for `type` + `pattern`

If an output declares both `type` and `pattern`, the explicit `pattern` takes precedence (the user asked for an exact regex; honor it). `type` alone yields the built-in pattern from Decision 2. Documented in the spec scenario set.

### Decision 6: Required-by-default is the accepted behavior change

All declared outputs are required. Agents that omit one now hit the existing retry→fail path. This is called out in proposal Impact and locked by a spec scenario. No opt-out flag this change.

## Parsing notes

`agent-parser.ts` already has `parseOutputsArray` handling simple (`- name`) and expanded (`- name:`/`description:`) forms. Extend the expanded branch to also read `type:` and `pattern:` per entry. `fork_session` is a root boolean (mirror the existing `interactive` parse). `context_files` is a root YAML array (reuse `parseYamlArray` via `context_files:array`).

## Risks

- **Regex injection into TypeBox/JSON-Schema `pattern`.** User-authored regex strings are passed through; a malformed pattern could throw at schema build. Wrap schema construction so a bad pattern degrades to a plain required string + parser diagnostic, rather than crashing the spawn.
- **`forkFrom` cost** for large operator sessions — acceptable; opt-in only.
- **Required-by-default** may surprise existing flows; mitigated by retry loop and CHANGELOG note.

## Migration

Additive frontmatter. Existing agents with bare `outputs` now require those outputs (behavior change, retry-mitigated). No flow-file changes required.
