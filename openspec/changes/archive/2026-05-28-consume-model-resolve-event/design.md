## Context

pi-flows today resolves model references in-process:

```
flow-engine/execution.ts
   ├─ resolveModel(agent.model, agent.thinking, getModelRole)
   │     ├─ if model.startsWith("@"): getModelRole(role) → literal
   │     └─ otherwise: pass through unchanged
   └─ Calls into pi-coding-agent which then uses the literal to find a Model
```

`getModelRole` is implemented in `extensions/role-manager.ts`:

```
loadRoleConfig() → reads ~/.pi/agent/providers.json#roles
saveRoleConfig() → writes the same
```

Plus event handlers (`flow:role-set`, `flow:role-get-all`, `flow:role-preset-*`) backing the dashboard's `RolesSettingsSection.tsx` UI.

Two adjacent recent changes:

1. `pi-dashboard-subagents` introduced `model:resolve` as the event-bus resolver and a `pi.modelRegistry` in-process fallback (change `add-model-resolve-event-with-fallback`).
2. `pi-agent-dashboard` is gaining a `model:resolve` handler that reads `providers.json#roles` directly and resolves all three input forms (`@role`, `provider/model`, bare `model-id`).

So `providers.json#roles` is now being read from TWO places: pi-flows (legacy) and the dashboard (new). The dashboard already owns `providers.json#providers`; making it own `providers.json#roles` too is the natural consolidation.

## Goals / Non-Goals

**Goals:**

- pi-flows becomes a pure consumer of `model:resolve`, identical in shape to the subagents extension.
- Flow YAML and agent-frontmatter syntax do not change. `model: @coding` continues to work.
- `agents/flow-architect.md` system prompt becomes aware of all three model-ref forms so generated agents can use any.
- Single source of truth for `providers.json#roles` (the dashboard).
- pi-flows' `isAutonomousMode` flag (currently squatting in `role-manager.ts`) survives the move in its own small module.

**Non-Goals:**

- Changing the `RolesSettingsSection.tsx` UI itself. It keeps talking to the same event names (handlers move under it but the wire contract stays).
- Renaming the `flow:role-*` event names. They keep the `flow:` prefix even after moving to the dashboard, to avoid a UI client change. (A future cleanup could rename them to `roles:*` — out of scope here.)
- Migrating `providers.json#roles` data on disk. The on-disk format and location are unchanged.
- Changing pi-flows' flow-engine architecture in any way beyond the resolveModel signature.

## Decisions

### Decision 1: pi-flows does NOT register a `model:resolve` handler

In the original draft of the companion change, pi-flows registered a cooperative `model:resolve` handler that resolved `@role` from its own in-memory map. We removed it because:

- It violates the "pi-flows is a consumer" simplification.
- Two handlers (dashboard + pi-flows) for the same event need an ordering rule. The `if (probe.model) return` early-return idiom works but adds cognitive overhead.
- pi-flows almost never runs without the dashboard in practice — the dashboard is what hosts the UI that flows talk to.

pi-flows EMITS `model:resolve`. It never LISTENS on it.

### Decision 2: Move the `flow:role-*` event handlers, not rename them

The events keep their `flow:` prefix when they move to the dashboard. Rationale:

- `RolesSettingsSection.tsx` already sends these names via the dashboard bridge — renaming would require coordinated UI + backend changes for zero functional benefit.
- The `flow:` prefix is historically misnamed, but renaming is a separate cleanup. Bundle one concern per change.

A future change can rename `flow:role-*` → `roles:*` once we're sure no third-party tooling depends on the old names.

### Decision 3: `resolveModel` keeps the same call site shape, just drops the `getModelRole` parameter

Today:

```ts
resolveModel(agent.model, agent.thinking, getModelRole)
```

After:

```ts
resolveModel(pi, agent.model, agent.thinking)
```

Why pass `pi`? The function needs `pi.events.emit` and `pi.modelRegistry`. Threading a `pi` handle through the four call sites is mechanical. The alternative — capturing `pi` in a module-level closure at activation time — is uglier because flow-engine isn't a top-level activate target; it's invoked deep in the flow execution pipeline.

### Decision 4: In-process fallback in pi-flows is symmetric with subagents

The fallback algorithm matches `extensions/agent.ts::resolveModelFromRef` in pi-dashboard-subagents:

- `@role` → fail with "no `model:resolve` handler" message (because role storage is owned by the dashboard, which we can't reach without it).
- `provider/model[:thinking]` → `pi.modelRegistry.find(provider, id)`.
- bare `model-id[:thinking]` → `pi.modelRegistry.getAll().find(m => m.id === id)`.

Same code shape, possibly even imported from a shared helper later. Right now we keep the implementation self-contained in pi-flows to avoid a new inter-package dep.

### Decision 5: `isAutonomousMode` gets its own module

`role-manager.ts` currently exports both `getModelRole` (role-related) and `isAutonomousMode` / `setAutonomousMode` (autonomous-vs-confirmation toggle for the flow engine — entirely unrelated to roles). Moving the latter into `extensions/autonomous-mode.ts` lets us delete `role-manager.ts` cleanly without dragging unrelated state across to the dashboard.

State persistence stays in the same `providers.json` file under a different key (`autonomousMode: true` at the top level — same as today).

### Decision 6: flow-architect.md update is documentation only, no schema change

The architect generates agent .md files. Today its system prompt only shows `model: @role` examples. We add a paragraph + table teaching it the other two forms so a user can ask "make me an agent using `claude-haiku-4-5:high` directly" and the architect knows that's allowed.

We do NOT change the parser, validators, or YAML schema — those already accept any string in `model:` (the validator runs later, at resolveModel time).

### Decision 7: Backward-compat window

The companion `pi-agent-dashboard` change keeps `flow:resolve-model` as a deprecated listener (already done) and adds the new `flow:role-*` listeners to support `RolesSettingsSection`. There is a brief window where both extensions register the `flow:role-*` handlers (during a partial upgrade). The handlers are read-only for `flow:role-get-all` and idempotent / last-writer-wins for the mutating events, so simultaneous registration is safe.

We document the upgrade order: **upgrade pi-agent-dashboard first**, then pi-flows. Reverse order leaves a release where the UI events have no backend.

## Risks / Trade-offs

- **[Risk]** Operators upgrading pi-flows without upgrading pi-agent-dashboard get a broken `RolesSettingsSection` (event handlers gone). → Document upgrade order; consider a runtime check at activate time: if `pi-agent-dashboard` is not loaded, log a warning pointing at the upgrade-order doc. Out of scope for the spec; nice-to-have for implementation.

- **[Risk]** External (third-party) tooling that listens on `flow:role-*` events breaks silently. → Confirmed via codebase search: only the dashboard's RolesSettingsSection emits/listens. No public docs advertise these events. We accept the risk.

- **[Trade-off]** `resolveModel` gains a `pi` parameter — a wider function signature for a static helper. → Acceptable; the alternative (module-level closure) requires an activation hook in flow-engine that doesn't exist yet.

- **[Risk]** The flow-architect, once aware of all three forms, may generate `provider/model` references that don't survive a model id rename upstream. Role aliases insulate users from such renames. → Document in the architect's prompt that `@role` is the preferred default; bare and literal forms are escape hatches.

- **[Risk]** During development the test suite for `role-manager.ts` (if any) will fail. → Audit before implementation; replace with tests for the new `flow-model-resolution` capability.

## Migration Plan

For end users: no action required. `model: @coding` in their flows keeps resolving the same way (just through a different path).

For ops:

1. Upgrade `pi-agent-dashboard` to the version with the relocated `flow:role-*` handlers.
2. Upgrade `pi-flows` to this change's version.

For the `providers.json` file itself: no migration. Schema unchanged; ownership of writes shifts from pi-flows to the dashboard but reads remain compatible.

Rollback: pi-flows can be downgraded independently of the dashboard. The dashboard's old handler (or the new dashboard's continued ownership of `flow:role-*`) keeps the file readable by older pi-flows builds that still call `getModelRole`.

## Open Questions

1. Should pi-flows ship a thin shim `getModelRole(role)` that emits `model:resolve` + returns the literal, to preserve the old in-process API for any tests / downstream that still call it? Lean: no — it's an internal API, no downstream uses it.

2. Should the architect's prompt say "prefer `@role`" or stay neutral? Lean: prefer `@role` (it's the documented convention and survives model renames), but enumerate the others as escape hatches.

3. `loadRoleConfig` returns `{ roles, rolePresets, activePreset, autonomousMode }`. The `roles` half moves to the dashboard. The `autonomousMode` half moves to `extensions/autonomous-mode.ts` within pi-flows. Where do `rolePresets` / `activePreset` live? Lean: they go with roles (they're role-preset bundles, conceptually part of role management). Dashboard owns them.
