## REMOVED Requirements

### Requirement: Conditional resolves typed outputs
**Reason**: The `conditional` step type is removed (see `decision-routing`); its typed-output branching role is superseded by `code-decision`, which consumes code-node typed outputs and routes on a reserved `branch` output.
**Migration**: Replace `type: conditional` with `type: code-decision`. Read the value previously checked (`check: <stepId>.<key>`) as a handler input and return `{ branch: "present" }` or `{ branch: "absent" }`, with `branches: { present: <present-target>, absent: <absent-target> }`. Standard fields (`artifacts`, `summary`, `files`, `status`) remain available as `${{result.<stepId>.<field>}}` inputs to the handler.
