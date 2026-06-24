# Tasks

## 1. Types & parsing

- [x] 1.1 `extensions/flow-engine/types.ts`: extend `AgentConfig`:
  - Add `fork_session?: boolean`.
  - Add `context_files?: string[]`.
  - Change `outputs` element to `{ name: string; description?: string; type?: "string" | "number" | "boolean"; pattern?: string }`.
- [x] 1.2 `extensions/flow-engine/agent-parser.ts`:
  - Parse root boolean `fork_session` (mirror `interactive`).
  - Parse root array `context_files` (via `context_files:array` + `parseYamlArray`).
  - Extend `parseOutputsArray` expanded branch to read `type:` and `pattern:` per entry.
  - Verify: parser unit test (task 5.1) fails before, passes after.

## 2. Finish schema enforcement (guard)

- [x] 2.1 `extensions/flow-engine/guard.ts`: in the declared-outputs loop (lines ~107-111):
  - Make each declared output **required** (drop `Type.Optional`).
  - `pattern` → `Type.String({ pattern })`.
  - `type: number` → numeric-string pattern; `type: boolean` → `^(true|false)$`; `type: string`/absent → plain `Type.String`.
  - When both `type` and `pattern` present, the explicit `pattern` wins (Decision 5).
  - Wrap regex use so an invalid pattern degrades to a plain required string (Risk mitigation).
- [x] 2.2 Confirm the SDK validation-fail path: malformed `finish` → `tool_execution_end.isError` → existing followUp retry at `execution.ts:457`. No new retry code.

## 3. Session fork

- [x] 3.1 Thread the main `SessionManager`:
  - `flow-engine/index.ts`: add `getSessionManager: () => sessionManager` to the FlowManager config object.
  - `flow-manager.ts` / `flow-execution.ts` (`FlowRunOptions`): carry `sessionManager?` through to `runFlow`.
  - `flow-execution.ts:560` spawn call: pass `mainSessionManager` into `spawnAgent` options.
- [x] 3.2 `execution.ts` `SpawnOptions`: add `mainSessionManager?: SessionManager`.
- [x] 3.3 `execution.ts` session creation (line ~349): when `agent.fork_session`:
  - `const file = options.mainSessionManager?.getSessionFile();`
  - file present → `SessionManager.forkFrom(file, cwd)`; else → `SessionManager.inMemory()` + diagnostic.
  - Default (flag off) → `SessionManager.inMemory()` unchanged.

## 4. Context-file injection

- [x] 4.1 `flow-execution.ts` (near preamble assembly, ~line 558): for each `agentConfig.context_files`, resolve against `cwd`, `readFileSync`, push `## Context: <path>\n\n<contents>` onto `preambleSections`. Skip missing/unreadable with a diagnostic.
- [x] 4.2 Confirm injection lands via existing `execution.ts:199-202` `## Context` block.

## 5. Tests (`__tests__/`)

- [x] 5.1 `agent-parser.test.ts`: parse all fields incl. `fork_session`, `context_files`, outputs with `type`/`pattern`; simple + expanded output forms; missing-field errors.
- [x] 5.2 `finish-schema.test.ts`: `createGuardExtension` builds finish params — declared outputs required; `pattern` surfaces as `Type.String({pattern})`; `type` maps to expected pattern; invalid regex degrades gracefully.
- [x] 5.3 `output-validation.test.ts`: simulate finish params — valid passes; missing required → isError; wrong-type/pattern-mismatch → isError; extra fields ignored.
- [x] 5.4 `context-files.test.ts`: context files read and injected as preamble sections; missing file skipped, non-fatal.
- [x] 5.5 `fork-session.test.ts`: `fork_session: true` + persisted main session → `forkFrom` used; unpersisted → `inMemory` fallback; flag off → `inMemory`. (Stub `SessionManager`.)

## 6. Verification

- [x] 6.1 `npm run typecheck` clean.
- [x] 6.2 `npm run lint` clean.
- [x] 6.3 `npm test` green (new suites included).
- [x] 6.4 `openspec change validate enhance-agent-node-contract` passes.

## 7. Docs

- [x] 7.1 `docs/agents.md` + `agent-docs/agents.md` (via subagent): document `fork_session`, `context_files`, output `type`/`pattern`, required-by-default behavior. Caveman rule for `agent-docs/`.
- [x] 7.2 `docs/flow-authoring.md` + mirror: full frontmatter reference update.
- [x] 7.3 `CHANGELOG.md`: note the required-by-default behavior change.
