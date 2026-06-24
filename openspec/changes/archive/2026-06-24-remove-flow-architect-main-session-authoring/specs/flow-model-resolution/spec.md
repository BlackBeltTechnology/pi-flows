## RENAMED Requirements

- FROM: `### Requirement: The flow-architect prompt SHALL teach all three `model:` reference forms`
- TO: `### Requirement: The edit-flow skill SHALL teach all three `model:` reference forms`

## MODIFIED Requirements

### Requirement: The edit-flow skill SHALL teach all three `model:` reference forms

The `edit-flow` skill (`skills/edit-flow/SKILL.md`) SHALL document the three accepted `model:` field forms with examples, so the main session can author agent definitions using any form (not only `@role`). The skill SHALL state which form is preferred (`@role`) and when the others are appropriate. (Previously this requirement targeted the deleted `agents/flow-architect.md` prompt; the teaching responsibility moves to the shipped skill.)

#### Scenario: All three forms are documented in the skill

- **WHEN** a developer reads `skills/edit-flow/SKILL.md`
- **THEN** the content SHALL include a section listing the three forms: `@role`, `provider/model[:thinking]`, and bare `model-id`
- **AND** the section SHALL include one example of each form
- **AND** the section SHALL state that `@role` is the preferred default
- **AND** the section SHALL state that `provider/model` and bare `model-id` are appropriate when (a) a specific model is required regardless of role config, or (b) the user explicitly asks for a non-role model

#### Scenario: Authored agent definitions can use any form

- **GIVEN** the user has asked for "an agent that always uses anthropic/claude-haiku-4-5:high"
- **WHEN** the main session authors the agent's frontmatter via `flow_agents`
- **THEN** the generated `model:` field MAY contain the literal `"anthropic/claude-haiku-4-5:high"`
- **AND** the resulting file SHALL be valid YAML and SHALL resolve correctly at runtime via the resolveModel implementation
