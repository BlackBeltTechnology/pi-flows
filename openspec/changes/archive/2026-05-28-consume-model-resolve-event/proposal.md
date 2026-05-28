## Why

`@blackbelt-technology/pi-dashboard-subagents` recently moved model-reference resolution onto a shared event-bus contract (`pi.events.emit("model:resolve", probe)`) with an in-process `pi.modelRegistry` fallback for the no-handler case. The companion change in `pi-agent-dashboard` makes the dashboard the canonical owner of `~/.pi/agent/providers.json#roles` and the canonical handler of `model:resolve` (handling `@role`, `provider/model[:thinking]`, and bare `model-id` in one place).

pi-flows currently owns role storage in `extensions/role-manager.ts` (reads/writes `providers.json#roles`, exposes `getModelRole()` to its own flow engine) and resolves model references in-process via `extensions/flow-engine/model-roles.ts`. This duplicates role-storage logic now living in the dashboard and prevents pi-flows from cleanly consuming the new event-bus contract.

The fix is straightforward: pi-flows becomes a **consumer** of `model:resolve`, exactly like pi-dashboard-subagents. It stops owning the roles file. The dashboard becomes the single source of truth.

Concretely:

- pi-flows' `flow:role-*` event handlers (set / get-all / preset-load / preset-save / preset-delete) move OUT of `pi-flows/extensions/role-manager.ts` and into `pi-agent-dashboard/packages/extension/`. The dashboard already provides the UI (`RolesSettingsSection.tsx`) — only the in-process backend moves.
- Flow execution stops calling `getModelRole(role)` directly. Instead, when an agent definition specifies `model: "@role"`, `model: "provider/id"`, or bare `model: "id"`, the flow engine emits `model:resolve` and reads the resulting `Model` from the probe, with a `pi.modelRegistry` fallback for the literal forms (same shape as the subagents extension).
- The flow architect agent (`agents/flow-architect.md`) is updated to document all three accepted `model:` forms in its system prompt so the generated agent definitions can use any of them — not just `@role`.

`grep -rn "flow:role" pi-packages/*/packages pi-packages/*/extensions` confirms only pi-flows handles these events and only the dashboard's `RolesSettingsSection` consumes them — there are no third-party listeners to worry about.

## What Changes

- **BREAKING (internal)** `extensions/role-manager.ts` is **removed** from pi-flows. Its responsibilities split:
  - `flow:role-set`, `flow:role-get-all`, `flow:role-preset-load`, `flow:role-preset-save`, `flow:role-preset-delete` handlers MOVE to `pi-agent-dashboard/packages/extension/` (companion change).
  - `getModelRole(role)` is **removed** from the public API.
  - The `isAutonomousMode` / `setAutonomousMode` toggles (which currently squat in `role-manager.ts`) move into a dedicated `extensions/autonomous-mode.ts` module within pi-flows — they have nothing to do with roles.
- **MODIFIED** `extensions/flow-engine/model-roles.ts` — the `resolveModel(model, thinking, getModelRole)` function loses its `getModelRole` parameter. It instead consults `pi.events.emit("model:resolve", probe)` for any form, with `pi.modelRegistry` fallback. Same primary-then-fallback algorithm pi-dashboard-subagents uses.
- **MODIFIED** every callsite of `resolveModel` (4 known: `execution.ts`, `flow-execution.ts`, `flow-workspace/index.ts` x2) updates to the new signature.
- **MODIFIED** `agents/flow-architect.md` — system prompt teaches the architect that the `model:` frontmatter field accepts three forms (`@role`, `provider/model[:thinking]`, bare `model-id`) and shows examples for each. The complete-example block keeps `@coding` for convention but a separate section enumerates the alternatives.
- Flow YAML and agent .md syntax do NOT change — `model: @coding` still works exactly as before. The change is purely in how pi-flows resolves the string, plus making the architect aware of two additional forms it can generate.

## Capabilities

### New Capabilities

- `flow-model-resolution`: How pi-flows resolves frontmatter / flow-YAML `model:` references via the shared `model:resolve` event bus contract. Captures the consumer-side algorithm (primary event → registry fallback), the supported input forms, and the error surface.

### Modified Capabilities

(none — pi-flows has no existing spec for in-flow model resolution; it was implementation-only until now.)

## Impact

- **Code**:
  - `extensions/role-manager.ts` — deleted.
  - `extensions/autonomous-mode.ts` — new, hosts the (unrelated) autonomous-mode state.
  - `extensions/index.ts` — drop the `activate` call for role-manager; add one for autonomous-mode.
  - `extensions/flow-engine/model-roles.ts` — rewritten around `model:resolve`.
  - `extensions/flow-engine/execution.ts`, `flow-execution.ts`, `flow-workspace/index.ts` — adapt to new `resolveModel` signature.
  - `extensions/flow-engine/index.ts` — drop the `getModelRole` re-export.
  - `extensions/flow-engine/flow-tui.ts` — re-import `isAutonomousMode`/`setAutonomousMode` from `autonomous-mode.ts`.
  - `agents/flow-architect.md` — docs update only.
- **Tests**: pi-flows has tests touching `role-manager.ts` (if any) — adapt or remove. Add unit tests for the new `model:resolve`-based `resolveModel`. Tests stub `pi.events` and `pi.modelRegistry` the same way `extensions/__tests__/model-resolve.test.ts` does in pi-dashboard-subagents.
- **Cross-repo coordination**: a companion change in `pi-agent-dashboard` MUST land first (or at least concurrently) to take ownership of the `flow:role-*` events. Without it, `RolesSettingsSection.tsx` would have no backend.
- **Runtime behavior**: identical for end users. Flow agents with `model: @coding` resolve the same way (via the dashboard handler now, instead of in-process). Operators with NEITHER dashboard NOR pi-agent-dashboard loaded lose `@role` resolution (same degradation as subagents — but pi-flows almost never runs without the dashboard in practice, since the dashboard is what hosts the UI).
- **No new dependencies.**
