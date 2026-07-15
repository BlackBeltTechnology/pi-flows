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

### D2 — Reconcile only on change, via a small extracted helper
`setActiveTools` rebuilding the prompt every turn would be wasteful and noisy, so
the reconcile is **change-gated**: it applies the tool set only when the newly
resolved value differs from the last applied value.

The change-gate + apply is extracted into a tiny pure helper,
`makeEditFlowToolReconciler({ getActiveTools, setActiveTools, editFlowTools })`
in `extensions/flow-engine/edit-flow-reconcile.js`, which returns a
`reconcile(enabled: boolean): boolean` closure holding the last-applied value.
This makes the decision directly unit-testable (enable→active, disable→inactive,
unchanged→no rebuild) without standing up the full `activate(pi)` wiring or a
faux session — the main-session tool-gating lifecycle is not exercised by the
faux flow/agent harness.

The helper replaces the former stateless inline `reconcileEditFlowTools` closure
and becomes the single reconcile path used by `session_start`,
`before_agent_start`, and the existing command/event `applyEditMode` calls — so
there is one cache, no staleness. `session_start` runs first and seeds the cache;
the first turn therefore does not needlessly reconcile.

### D3 — Remove the project-trust gate
The project-trust gate on `flows.editFlow` is removed: `isEditFlowEnabled` no
longer takes a `projectTrusted` argument and always reads the project
`.pi/settings.json` (project overrides global; global always honored). The
`session_start` and `before_agent_start` handlers therefore stop resolving
`ctx.isProjectTrusted()`. Rationale: the gate was a no-op for trusted projects
(the common case) and its only effect was to ignore an untrusted project's own
`flows.editFlow`; the authoring tools only write flow/agent definition files, and
the gate added friction without meaningful protection for this flag. This flips
the `flow-authoring` "gated by `flows.editFlow`" requirement from
trusted-projects-only to honored-regardless-of-trust.

### D4 — Scope: tools only, not skill visibility
Skill prompt-visibility (`manage-flows` frontmatter) is coupled to
`session_start`/reload and stays that way. Making it live would require reloading
resources mid-turn, which is out of scope. The observed gap is the **tools**, and
only the tools are reconciled per turn.

## Open questions

- None blocking. Confirm during implementation that `before_agent_start`'s
  reconcile is reflected in the same turn's tool set; if the primitive defers to
  the following turn, the behavior is next-turn — either way no restart is
  required. (The unit test asserts the reconciler's apply/skip decisions
  directly; the turn-timing of `setActiveTools` is the platform's contract.)
