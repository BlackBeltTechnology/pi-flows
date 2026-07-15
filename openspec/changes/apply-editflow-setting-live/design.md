## Context

`flows.editFlow` gates the `flow_agents`/`flow_write` authoring tools. Today the
flag is read only at `session_start` (and pushed by the command/event handlers).
A running session never re-reads it, so an out-of-band edit to `.pi/settings.json`
is invisible until restart.

## Decisions

### D1 — Trigger: poll at turn start (`before_agent_start`), not a file watcher
Re-read the flag and reconcile at the start of each agent turn.

- `setActiveTools`/`setActiveToolsByName` rebuilds the system prompt and takes
  effect **on the next agent turn** regardless — so a turn boundary is the
  earliest point a tool-set change can actually matter. Polling there loses no
  liveness that the primitive itself would honor sooner.
- `before_agent_start` fires before the turn's provider request is built, so a
  reconcile there lands on the turn about to run.
- Rejected: `fs.watch` on the settings file. It is "more instant" (applies while
  idle, between turns) but carries watcher-lifecycle cost and a known
  atomic-write pitfall — editors and read-merge-write savers replace the file via
  tmp+rename, which detaches an inode-based `fs.watch`; correct handling requires
  watching the directory and re-attaching. Not worth it for a per-turn setting.

### D2 — Reconcile only on change (cached `lastEnabled`)
`setActiveTools` rebuilding the prompt every turn would be wasteful and noisy.
Cache the last resolved value; call `reconcileEditFlowTools` only when the newly
resolved value differs. Seed the cache from the `session_start` resolution so the
first turn does not needlessly reconcile.

### D3 — Trust gate unchanged
The `before_agent_start` poll resolves the flag with the same
`projectTrusted: ctx.isProjectTrusted()` argument used at `session_start`. Trust
behavior is intentionally untouched by this change.

### D4 — Scope: tools only, not skill visibility
Skill prompt-visibility (`manage-flows` frontmatter) is coupled to
`session_start`/reload and stays that way. Making it live would require reloading
resources mid-turn, which is out of scope. The observed gap is the **tools**, and
only the tools are reconciled per turn.

## Open questions

- None blocking. Confirm during implementation that `before_agent_start`'s
  reconcile is reflected in the same turn's tool set (assert via the faux-model
  test); if the primitive defers to the following turn, the test asserts the
  next-turn behavior instead — either way no restart is required.
