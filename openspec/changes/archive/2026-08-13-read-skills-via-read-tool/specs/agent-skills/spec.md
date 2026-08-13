## ADDED Requirements

### Requirement: Declared skills are advertised in the agent prompt, not injected as bodies

When a flow agent (agent step or agent-decision step) declares one or more
`skills:`, the engine SHALL resolve each declared skill name to a pi `Skill`
object using pi's `loadSkillsFromDir`, and SHALL advertise the resolved skills in
the agent's system prompt using pi's `formatSkillsForPrompt` — i.e. each skill's
`name`, `description`, and `<location>` (the absolute `SKILL.md` path). The engine
SHALL NOT inject the `SKILL.md` body into the prompt. Skill names that cannot be
resolved SHALL be skipped (no prompt entry, no error).

Skill directory resolution SHALL search extra skills directories registered via
`flow:register-skills-dir` first, then the pi-flows package `skills/` directory.

#### Scenario: A declared skill is advertised by location

- **WHEN** an agent declares `skills: docs-x` and `docs-x/SKILL.md` resolves
- **THEN** the agent's system prompt SHALL contain an `<available_skills>` block naming `docs-x` and its `<location>` (the absolute `SKILL.md` path)
- **AND** the prompt SHALL NOT contain the `SKILL.md` body text

#### Scenario: No skills declared

- **WHEN** an agent declares no `skills:`
- **THEN** the agent's system prompt SHALL NOT contain an `<available_skills>` block

### Requirement: `read` is auto-granted to skill-declaring agents

When an agent declares `skills:` but does not list `read` in its `tools:`, the
engine SHALL add `read` to the agent's effective tool set so it can load the
advertised `SKILL.md` and any topic files. This SHALL apply to both agent steps
and agent-decision steps.

#### Scenario: read added when skills present and read absent

- **WHEN** an agent declares `skills: docs-x` and `tools:` without `read`
- **THEN** the agent's session SHALL expose the `read` tool and the guard SHALL permit `read`

### Requirement: Skill directories are whitelisted into a read sandbox

When a skill-declaring agent restricts reads with `access.read`, the engine SHALL
widen that agent's allowed read paths to include each resolved skill's directory,
so the advertised skill files are readable. The widening SHALL NOT grant read
access to any path outside the agent's own `access.read` globs and the resolved
skill directories. Agents without `access` rules are unrestricted and require no
widening.

#### Scenario: Restrictive sandbox still allows skill files

- **WHEN** an agent declares `skills: docs-x` and `access.read` that excludes the skill directory
- **THEN** a `read` of the skill's `SKILL.md` (or a topic file under the skill directory) SHALL be permitted
- **AND** a `read` of an unrelated path outside both the declared globs and the skill directory SHALL still be denied

### Requirement: No `skill_read` tool exists

The engine SHALL NOT register a `skill_read` tool on the main session and SHALL
NOT provide one to subagent sessions. `skill_read` SHALL NOT be an accepted
agent-frontmatter tool name: declaring it in `tools:` SHALL be a validation
error. Skill files are read with the standard `read` tool.

#### Scenario: Declaring skill_read fails validation

- **WHEN** an agent declares `tools:` containing `skill_read`
- **THEN** agent validation SHALL report an error for the unknown tool `skill_read`

### Requirement: Read-access denials identify the target and, on first denial, the allowed paths

The guard's read-access enforcement SHALL evaluate the read tool's actual `path`
parameter (accepting a legacy `file_path` as a fallback). When a read is denied
by `access.read`, the block reason SHALL name the attempted path. On the **first**
read denial within an agent session, the reason SHALL additionally list the
agent's allowed read paths; subsequent denials MAY omit the list.

#### Scenario: First read denial lists allowed paths

- **WHEN** an agent with `access.read` reads a path outside its allowed globs for the first time
- **THEN** the read SHALL be blocked
- **AND** the block reason SHALL name the attempted path and list the allowed read paths

#### Scenario: Read access evaluates the path parameter

- **WHEN** the read tool is invoked with its `path` parameter and `access.read` is set
- **THEN** the guard SHALL match that `path` value against the allowed globs (not an absent `file_path`)
