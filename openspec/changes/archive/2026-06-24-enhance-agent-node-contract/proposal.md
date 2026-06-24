# Enhance the Agent Node Contract

## Why

The agent node's contract is too weak in four concrete ways, each verified in source:

1. **No session inheritance from the main session.** Every agent gets a fresh `SessionManager.inMemory()` (`execution.ts:349`). There is no frontmatter switch to inherit the operator's working context — only `authStorage` and `modelRegistry` are reused. Agents that should continue the operator's working context start cold. pi's SDK exposes `SessionManager.forkFrom(sourcePath, cwd, …)` (`session-manager.d.ts:317`), and the main session is captured at `flow-engine/index.ts:204` (`ctx.sessionManager`), but it is never threaded into spawn.
2. **Outputs are not a validated contract.** Declared outputs (`outputs: [{name, description?}]`) become `Type.Optional(Type.String(...))` on the finish tool (`guard.ts:107-111`), and extraction is a blind `String(value)` with no required-field enforcement and no content validation (`execution.ts:605-616`). An agent can omit a declared output or return a malformed value (e.g. a file path phrased a dozen different ways) and nothing catches it. Downstream consumers — especially a future **code node** that needs a deterministic file path — cannot rely on the shape.
3. **No project-context injection.** Project conventions (e.g. `AGENTS.md`) are never auto-injected into agent context; the only path is manually adding the `project-context-reader` agent as a step. There is no frontmatter option to pre-read a file into the agent's system prompt.
4. **Zero tests** for agent parsing, finish handling, or output extraction (`__tests__/` covers abort/persistence/model-resolution only).

## What changes

Strengthen the agent frontmatter contract and enforce it, plus add follow-up tests.

- **(a) `fork_session` frontmatter flag.** Opt-in to inherit the operator's session data when spawning the agent. When set, `spawnAgent` forks the main session's persisted file via `SessionManager.forkFrom(mainSession.getSessionFile(), cwd)` and seeds it into `createAgentSession({ sessionManager })`. Falls back to `SessionManager.inMemory()` (current behavior) when the main session is not persisted to disk. Default off.
- **(b) Validated string outputs.** Outputs remain **string-valued on the wire** (`typedOutputs: Record<string, string>` unchanged). Each declared output MAY carry:
  - `type: string | number | boolean` — a content constraint on the string (e.g. `number` → numeric string).
  - `pattern: <regex>` — a regex the string value MUST match (the deterministic-output use case).
  Inputs stay bare names — no input typing or validation (the validated output's name carries the contract).
- **(c) `context_files` frontmatter list.** Each path is read at spawn and injected as a preamble section into the agent's system prompt (reusing the `preambleSections` injection point at `flow-execution.ts:560`). `AGENTS.md` is just one possible path. Missing files are skipped with a diagnostic, not fatal.
- **(d) Finish-output validation + retry.** Declared outputs are **required by default**. The finish tool's TypeBox schema is tightened: required fields become non-optional, and `pattern`/`type` map to `Type.String({ pattern })` / numeric/boolean constraints, so the **SDK rejects** a non-conforming `finish` call. The existing schema-validation followUp retry (`execution.ts:457`) re-prompts the agent; the step fails after `MAX_FINISH_RETRIES`.
- **(e) Follow-up tests.** New suites covering: frontmatter parsing (all fields incl. `fork_session`, `context_files`, typed/pattern outputs), finish-tool schema construction, output validation (missing / wrong-type / pattern-mismatch / valid), context-file injection, and session-fork behavior.

## Impact

- **Affected specs:** `agent-node` capability — frontmatter schema (`fork_session`, `context_files`, output `type`/`pattern`), finish-output validation behavior, session inheritance.
- **Affected code:** `agent-parser.ts`, `types.ts` (`AgentConfig`, output shape), `guard.ts` (finish schema), `execution.ts` (spawn/session fork, context-file preamble, validated-output extraction), `flow-execution.ts` (thread `sessionManager`); new `__tests__/` suites.
- **Backward compatibility:** mostly additive. `fork_session` and `context_files` default to current behavior. Outputs without `type`/`pattern` validate as plain required strings. The **required-by-default** check is a behavior change for agents that currently omit declared outputs — they will now be re-prompted/failed; mitigated by the existing retry loop.
- **Out of scope:**
  - The generic **code node** (separate change), though it consumes the validated-output guarantees produced here.
  - Removing/replacing the finish tool itself.
  - Input typing/validation.
  - Per-output `required: false` opt-out (can be added later if a concrete need appears).
  - Cross-session persistence of forked context beyond the run.
