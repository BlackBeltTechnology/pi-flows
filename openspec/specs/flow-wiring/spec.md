# flow-wiring Specification

## Purpose
TBD - created by archiving change harden-flow-wiring. Update Purpose after archive.
## Requirements
### Requirement: Template variable resolution is covered end-to-end
The template-expansion engine SHALL be exercised by tests covering every supported variable form: `${{task}}`, `${{input.NAME}}`, `${{result.STEP}}`, `${{result.STEP.summary}}`, `${{result.STEP.status}}`, `${{result.STEP.artifacts}}`, `${{result.STEP.files}}`, `${{result.STEP.<typedOutput>}}`, `${{loop.STEP.iteration}}`, and `${{loop.STEP.max}}`.

#### Scenario: Standard fields resolve
- **WHEN** a task references `${{result.extract.summary}}` and `extract` completed with a summary
- **THEN** the expansion yields that summary string

#### Scenario: Typed output resolves
- **WHEN** a step references `${{result.validate.verdict}}` and `validate` declares and emitted a `verdict` output
- **THEN** the expansion yields that output's string value

#### Scenario: Loop variables resolve
- **WHEN** a loop-decision task references `${{loop.verify.iteration}}/${{loop.verify.max}}`
- **THEN** the expansion yields the current 1-based iteration and the configured maximum

### Requirement: Unresolvable references fail flow validation
A flow SHALL fail validation at load time when a template references an unknown step ID, or an unknown output field of a known step. Standard fields (`summary`, `status`, `artifacts`, `files`, `fullOutput`) always resolve. A typed-output field is known when the referenced agent or code node declares it in `outputs`.

#### Scenario: Unknown step ID is rejected
- **WHEN** a step references `${{result.nonexistent}}` and no step `nonexistent` exists
- **THEN** flow validation fails with a diagnostic naming the unknown step and the referencing step

#### Scenario: Typo in output field is rejected
- **WHEN** a step references `${{result.extract.totl}}` and `extract` declares outputs `[total]`
- **THEN** flow validation fails with a diagnostic naming the unknown field `totl`

#### Scenario: Standard fields always pass
- **WHEN** a step references `${{result.extract.summary}}`
- **THEN** validation accepts it regardless of declared outputs

### Requirement: Referenced results must be ordered before use
A template reference to `${{result.X...}}` SHALL be valid only when X is guaranteed to have completed before the referencing step — that is, X is a transitive `blockedBy` ancestor of the step, OR X reaches the step through an `on_error` routing chain or a decision/loop branch chain. Otherwise flow validation fails. The engine SHALL NOT silently add the implied dependency edge.

#### Scenario: Reference without ordering is rejected
- **WHEN** step `B` references `${{result.A.summary}}` but `A` is neither a transitive `blockedBy` ancestor of `B` nor routes into `B`
- **THEN** flow validation fails with a diagnostic naming `A`, `B`, and the missing dependency

#### Scenario: Reference satisfied by blockedBy passes
- **WHEN** step `B` references `${{result.A.summary}}` and declares `blockedBy: [A]`
- **THEN** validation accepts the reference

#### Scenario: Reference satisfied by on_error routing passes
- **WHEN** step `A` declares `on_error: B` and `B` references `${{result.A.summary}}`
- **THEN** validation accepts the reference even without `blockedBy`

### Requirement: Loop iteration counter is 1-based and consistent
The `${{loop.STEP.iteration}}` value SHALL be 1-based, and the loop body executing pass N SHALL observe the same iteration number N as the loop-decision step for that pass.

#### Scenario: First body pass sees 1
- **WHEN** a loop body step references `${{loop.verify.iteration}}` on the first pass
- **THEN** the expansion yields `1` (not `0`)

#### Scenario: Body and decision agree
- **WHEN** the loop body and the loop-decision step both reference `${{loop.verify.iteration}}` within the same pass N
- **THEN** both observe N

### Requirement: The `reads` step field is removed
The engine SHALL NOT define or parse a `reads` field on any step. File-content injection is provided by the agent `context_files` frontmatter field.

#### Scenario: reads is not parsed
- **WHEN** a flow YAML contains a `reads:` key on a step
- **THEN** the parser does not produce a `reads` property on the step (the key is ignored as an unknown field)

### Requirement: flow-ref result propagation is covered
Sub-flow results merged into the parent context via a `flow-ref` step SHALL be exercised by tests, including downstream references to sub-flow step results.

#### Scenario: Sub-flow result is referenceable
- **WHEN** a `flow-ref` step runs a sub-flow whose step `inner` completes
- **THEN** a downstream parent step can reference `${{result.inner.summary}}`

