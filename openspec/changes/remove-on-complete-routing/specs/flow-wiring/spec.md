## MODIFIED Requirements

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
