## 1. Skill advertising (pi-parity)

- [x] 1.1 Resolve declared skill names to pi `Skill` objects via `loadSkillsFromDir` (`index.ts` `getSkill`, replacing the `getSkillContent` body reader)
- [x] 1.2 Thread resolved `Skill[]` through the flow executor to `spawnAgent` for both agent and agent-decision steps (`flow-execution.ts`, `flow-manager.ts`)
- [x] 1.3 Advertise skills in the system prompt with pi's `formatSkillsForPrompt` instead of injecting the `SKILL.md` body (`execution.ts`)

## 2. Reading skill files under gating

- [x] 2.1 Auto-grant `read` to agents that declare `skills:` but not `read` (`execution.ts`)
- [x] 2.2 Whitelist each resolved skill directory into the agent's `access.read` when the agent sandboxes reads (`execution.ts`)

## 3. Remove `skill_read`

- [x] 3.1 Stop registering `skill_read` on the main session; drop the tool factory (`index.ts`, `tools/skill-read.ts` trimmed to `findSkillDir`/`registerExtraSkillsDir`)
- [x] 3.2 Remove `skill_read` from `BASE_TOOLS` so declaring it is a validation error (`tools/agent-validate.ts`)

## 4. Guard read-access fix

- [x] 4.1 Evaluate the read tool's `path` parameter (fallback `file_path`) in the access check (`guard.ts`)
- [x] 4.2 On the first read denial, include the allowed read paths in the block reason; keep later denials terse (`guard.ts`)

## 5. Tests & docs

- [x] 5.1 `spawnFaux` gains an additive `skills?: Skill[]` passthrough (`testing.ts`)
- [x] 5.2 Characterization tests: advertise-not-body, no-skills negative, auto-read + whitelist under a restrictive sandbox, topic-file read, and sandbox still blocks unrelated paths with the allowed-paths hint (`__tests__/faux-skills-injection.test.ts`)
- [x] 5.3 Update docs to the read-based mechanism and remove `skill_read` (`tools-reference.md`, `agents.md`, `flow-authoring.md`, `skills-and-extensions.md`, `extending-pi-flows.md`, `events-api.md`, `public-api.md`, `manage-flows/SKILL.md`)
- [x] 5.4 Full gate green: `npm run typecheck`, `npm test` (349), `npm run lint` (0 errors)
