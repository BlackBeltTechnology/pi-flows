## REMOVED Requirements

### Requirement: Skill directories are whitelisted into a read sandbox
**Reason**: The agent `access:` block is removed. Its in-process path checks never took effect (the block parsed to nothing) and could not confine `bash`. Confinement now comes from the docker sandbox (`agent-docker-sandbox`).
**Migration**: Remove `access:` from agent frontmatter. To confine agents, set `flows.sandbox.backend: "docker"`; declared skill directories are then mounted read-only into the agent's container.

### Requirement: Read-access denials identify the target and, on first denial, the allowed paths
**Reason**: There are no in-process read rules any more, so there are no read-access denials to report. In docker mode a path outside the project folder simply does not exist in the container.
**Migration**: None needed for agents. Tooling that matched on the "Access denied: read" message should match on the tool's normal file-not-found error instead.
