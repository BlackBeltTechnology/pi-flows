## REMOVED Requirements

### Requirement: Skill directories are whitelisted into a read sandbox
**Reason**: The agent `access:` block is removed. Its in-process path checks never took effect (the block parsed to nothing) and could not confine `bash`. Confinement now comes from a pi-flows executor (`agent-executor-hook`).
**Migration**: Remove `access:` from agent frontmatter. To confine agents, select an executor with `flows.executor`; executors receive the declared skill directories and may mount them read-only.

### Requirement: Read-access denials identify the target and, on first denial, the allowed paths
**Reason**: There are no in-process read rules any more, so there are no read-access denials to report. With an isolating executor a path outside the project folder simply does not exist for the agent.
**Migration**: None needed for agents. Tooling that matched on the "Access denied: read" message should match on the tool's normal file-not-found error instead.
