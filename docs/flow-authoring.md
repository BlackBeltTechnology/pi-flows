# Flow Authoring Reference

This document covers the formats for Agent `.md` files and Flow `.yaml` files.

## Agent Definition (`.md`)

Agents are defined in Markdown files. The frontmatter defines the configuration, and the body serves as the system prompt.

### Frontmatter Reference

```yaml
---
id: code-reviewer
name: Code Reviewer
description: Analyzes code changes and suggests improvements.
role: reviewer # Optional: role mapping for model selection
tools: # Tools available to this agent
  - read
  - grep
skills: # Shared skills to inject
  - git-utils
inputs: # Expected input schema (JSON Schema format)
  type: object
  properties:
    diff:
      type: string
  required: [diff]
---
You are an expert code reviewer. Examine the diff provided in your input and suggest actionable improvements...
```

## Flow Definition (`.yaml`)

Flows are DAGs defined in YAML.

### Flow Properties

- `id`: Unique identifier
- `name`: Display name
- `description`: Brief summary
- `inputs`: Global input schema required to start the flow
- `steps`: Array of step definitions

### Step Types

#### `agent` Step
Executes an agent.

```yaml
- id: review
  type: agent
  agent: code-reviewer
  inputs:
    diff: ${{input.git_diff}}
  dependsOn: [prepare_diff]
```

#### `fork` Step
Creates parallel branches.

```yaml
- id: process_files
  type: fork
  items: ${{input.files}}
  itemVar: file
  step:
    type: agent
    agent: file-analyzer
    inputs:
      targetFile: ${{file}}
```

#### `conditional` Step
Executes a step only if a condition is met.

```yaml
- id: maybe_fix
  type: conditional
  condition: ${{steps.review.output.needs_fixes}}
  step:
    type: agent
    agent: code-fixer
```

#### `decision` Step
Pauses flow for user input/selection.

```yaml
- id: user_approval
  type: decision
  message: "Proceed with deployment?"
  options: ["yes", "no"]
```

#### `flow` Step
Executes a sub-flow.

```yaml
- id: run_tests
  type: flow
  flow: test-pipeline
  inputs:
    srcDir: "./src"
```

## Template Variables

Values in `inputs` blocks can be populated dynamically:

- `${{input.foo}}`: Access the flow's global input `foo`.
- `${{steps.stepId.output.bar}}`: Access the output `bar` from a previous step named `stepId`.
- `${{steps.stepId.summary}}`: Access the human-readable summary of `stepId`.
- `${{env.VAR_NAME}}`: Access environment variables.
