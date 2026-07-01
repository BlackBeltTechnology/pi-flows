## Why

The original approach (opt-in `auto_end` + `ctx.shutdown()`) is the wrong lever: in a dashboard-spawned headless/RPC run, `ctx.shutdown()` is a **no-op** (the headless mode binds the default no-op shutdown handler) and the RPC keeper sidecar keeps the process alive regardless. Meanwhile the automation runner already finalizes prompt/skill runs the instant a normal agent turn emits **`agent_end`** — it captures the result and displays success/failure. A `flows.run` action injects the `flow:run` *event* instead of seeding a prompt, so the parent session never runs a turn, never emits `agent_end`, and the run hangs until a ~160s timeout → "error".

The fix is to make a flow run terminate through the **same `agent_end` path** every other action already uses. Crucially, **`agent_end` does not shut anything down** — it only signals "this turn/agent is done," so pi-flows can emit it unconditionally and safely. No opt-in key, no gate, no `ctx.shutdown()` are needed. Actual session teardown is the automation layer's concern and is handled there separately.

## What Changes

- **Remove the `auto_end` flow key**, the non-TUI/`ctx.mode` gate, and the `ctx.shutdown()` call. pi-flows does **not** shut down sessions.
- On flow completion (any terminal outcome), pi-flows **emits an `agent_end`-equivalent completion signal** carrying flow-outcome metadata — `status` (`success` | `error` | `aborted`) and a human-readable summary of what happened — so an automation runner can finalize the run and display success/failure exactly as it does for prompt/skill actions.
- Emission is **unconditional and side-effect-free** (it never closes a session), so it is safe in every mode (tui/rpc/print/json).
- Keep the `FlowResult.status` population fix (`success`/`aborted`) — it is the metadata source for the completion signal.

## Capabilities

### New Capabilities
- `flow-completion-signal`: on flow completion, emit a turn/agent-completion signal (`agent_end`) with outcome metadata (`status` + summary), so a host/automation runner finalizes and displays the run. No session shutdown; no opt-in.

### Modified Capabilities
<!-- none — this supersedes the unshipped auto_end/ctx.shutdown design within the same change. -->

## Impact

- **Code:** remove `auto_end` from `types.ts`/`flow-parser-yaml.ts`, delete `auto-end.ts`'s shutdown gate and the `ctx.shutdown()` wiring in `index.ts`; on `flow:complete` emit the completion signal + `agent_end` with metadata. Keep `FlowResult.status`.
- **API/boundary:** `agent_end` is a **core pi lifecycle event**; a pi extension emits custom `flow:*` events, not core events. The exact mechanism to surface `agent_end` to the host is the key open question (see design): run the flow inside a real agent turn, a pi API to emit `agent_end`, or the dashboard mapping forwarded `flow:complete` → its `agent_end` finalize path.
- **Docs/skill:** remove `auto_end` and the shutdown wording from `docs/flows.md`, `docs/flow-authoring.md`, `docs/public-api.md`, and the `manage-flows` skill; document the completion signal instead.
- **Out of scope:** actually shutting down / tearing down the run session and keeper — owned by the automation layer, handled separately by the user.
