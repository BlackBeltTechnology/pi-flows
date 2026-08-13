## Why

An agent that declared `skills:` in its frontmatter received the entire `SKILL.md`
**body** injected into its system prompt, and a `skill_read` tool was registered
only on the **main session** — never wired into subagent sessions. So a flow
agent could be told to "use `skill_read`" (the docs and every example agent said
so) but the tool was not present in its session, and it had no way to open the
topic files a `SKILL.md` references. The advertised progressive-disclosure model
did not work for flow agents at all.

pi's own skill mechanism does not use a bespoke tool: it advertises each skill's
**name + description + location** in the prompt and the agent reads `SKILL.md`
and its topic files on demand with the ordinary `read` tool. Flow subagents
differ from pi's main session in two ways that break a naive copy of that model:
they may not declare `read`, and they may sandbox it with `access.read`. A latent
guard bug compounded this — the read-access check compared `params.file_path`
while the read tool's parameter is `path`, so any agent with `access.read` had
**every** read blocked (the gate never saw the real path).

## What Changes

- **Skills are advertised the pi way.** When an agent declares `skills:`, each
  skill is resolved with pi's `loadSkillsFromDir` and advertised in the system
  prompt with pi's `formatSkillsForPrompt` (name, description, and `<location>` —
  the absolute `SKILL.md` path). The `SKILL.md` body is **no longer** dumped into
  the prompt.
- **`read` is auto-granted** to any agent that declares `skills:` but not `read`,
  so it can load the advertised files.
- **Skill directories are whitelisted** into the agent's `access.read` globs when
  the agent sandboxes reads, so a restrictive read sandbox still permits the
  advertised skill files — and nothing else outside the sandbox.
- **`skill_read` is removed entirely.** It is no longer registered on the main
  session, is not wired into subagents, and is no longer a valid frontmatter
  tool (declaring it is a validation error). Reading skill files is done with
  `read`.
- **The guard's read-access enforcement is fixed.** It reads the correct `path`
  parameter, and on the **first** read denial it lists the allowed read paths in
  the block reason so the agent can self-correct; later denials stay terse.

## Capabilities

### New Capabilities
- `agent-skills`: how a flow agent's declared `skills:` are resolved, advertised
  in its prompt (pi's `formatSkillsForPrompt`), and read on demand with `read`
  (auto-granted, with skill directories whitelisted into `access.read`); the
  absence of any `skill_read` tool; and the guard's read-access enforcement
  (correct `path` field + first-denial allowed-paths hint).

## Impact

- Engine: `spawnAgent` prompt/tool assembly, the flow executor's skill
  resolution, the guard's access enforcement, agent-frontmatter validation, and
  the shipped faux-testing harness (`spawnFaux` gains `skills`).
- **BREAKING for downstream agents that declared `skill_read` in `tools:`** —
  they must remove it; `read` is auto-granted when `skills:` is set.
