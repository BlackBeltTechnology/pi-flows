# Enhance the Agent Node Contract

## Why

The agent node's contract is too weak in four concrete ways, each verified in source:

1. **No session fork from the main session.** Every agent gets a fresh `SessionManager.inMemory()` (`execution.ts:315`). There is no frontmatter switch to fork/inherit the main session's context — only `authStorage` and `modelRegistry` are reused (`index.ts:197`). Agents that should continue the operator's working context start cold.
2. **Input declarations are not enough of a contract.** `inputs[]` are bare names; outputs (`outputs: [{name, description?}]`) are the only structured side, and even they are weakly enforced (see #3). There is no validated I/O contract on the input side.
3. **No finish-output type check.** Declared outputs become `Type.Optional(Type.String(...))` on the finish tool (`guard.ts:107-111`), and extraction is a blind `String(value)` with no required-field enforcement and no type beyond string (`execution.ts:605-616`). An agent can omit a declared output or return the wrong shape and nothing catches it.
4. **No AGENTS.md inheritance.** Project `AGENTS.md` is never auto-injected into agent context; the only path is manually adding the `project-context-reader` agent as a step. There is no frontmatter option to inherit project conventions.

There are also **zero tests** for agent parsing, finish handling, or output extraction (`__tests__/` covers abort/persistence/model-resolution only).

## What changes

Strengthen the agent frontmatter contract and enforce it, plus add follow-up tests.

- **(a) `fork_session` frontmatter flag.** Opt-in to fork/inherit the main session context when spawning the agent (instead of `SessionManager.inMemory()`). Parsed in `agent-parser.ts`, honored in `spawnAgent` (`execution.ts:315`). Default off (current behavior).
- **(b) Stronger I/O contract.** Allow declared `inputs`/`outputs` to carry a type beyond string (e.g. `type: string|number|enum|object`), parsed in `agent-parser.ts` and surfaced in the finish tool schema (`guard.ts:107`) rather than always `Optional(String)`.
- **(c) `inherit_agents_md` frontmatter flag.** When set, load project `AGENTS.md` and inject it as a preamble section at spawn (`flow-execution.ts:560` injection point). Optionally make it part of a default inherit set.
- **(d) Finish-output type check.** Validate `finishParams` against declared output types: required outputs must be present, values must match the declared type. On mismatch, reuse the existing finish-retry path (`execution.ts:437`) to re-prompt the agent; fail the step after retries are exhausted.
- **(e) Follow-up tests.** New suites covering: frontmatter parsing (all fields incl. new flags), finish-tool schema construction, output type validation (missing/wrong-type/extra), AGENTS.md injection, and session-fork behavior.

## Impact

- **Affected specs:** `agent-node` capability — frontmatter schema (`fork_session`, `inherit_agents_md`, typed inputs/outputs), finish-output validation behavior.
- **Affected code:** `agent-parser.ts`, `types.ts` (`AgentConfig`), `guard.ts` (finish schema), `execution.ts` (spawn/session, typed-output extraction + validation), `flow-execution.ts` (preamble injection); new `__tests__/` suites.
- **Backward compatibility:** mostly additive. New flags default to current behavior. The finish-output type check is a **behavior change** for agents that currently omit declared outputs — they will now be re-prompted/failed; mitigated by the existing retry loop.
- **Out of scope:**
  - The generic code node (separate change), though it shares the typed-output-validation machinery.
  - Removing/replacing the finish tool itself.
  - Cross-session persistence of forked context beyond the run.
