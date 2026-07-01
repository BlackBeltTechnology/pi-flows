## Why

Automation-spawned sessions (e.g. the dashboard firing `flow:run`) have no lifecycle close: after the flow reaches a terminal state the parent session lingers indefinitely, holding resources and cluttering the session list. There is currently no way for a flow run to signal "my work is done, end the session." pi already exposes a graceful `shutdown()` action — flows just never invoke it.

## What Changes

- Add an opt-in **auto-end** capability: when a flow reaches a terminal state, the parent session can gracefully shut down via `pi.shutdown()`.
- New per-flow YAML key `auto_end` (top-level in `flow.yaml`) — a flow must explicitly opt in; default off.
- Auto-end is honored only in **non-interactive** (headless) sessions — the whole motivating case — so an interactive human session is never closed out from under them.
- Auto-end fires only on **successful** completion (never on `aborted`; `error` excluded) — status filtering is part of the gate.
- Gate = flow opts in AND session is non-interactive AND status is success. No session-level setting: the non-interactive condition provides the blast-radius protection a consent setting would, without the extra config surface.

## Capabilities

### New Capabilities
- `flow-auto-end`: gated, opt-in graceful shutdown of the parent session when a flow reaches a terminal state — the `auto_end` flow key, the non-interactive + terminal-status gate, and the `flow:complete` → `shutdown()` wiring.

### Modified Capabilities
<!-- None. flow-authoring gains a new optional key but its existing requirements are unchanged; the new key is specified entirely within flow-auto-end. -->

## Impact

- **Code:** `extensions/flow-engine/types.ts` (`FlowConfig.auto_end`), `extensions/flow-engine/flow-parser-yaml.ts` (parse the key), and a `flow:complete` listener in `extensions/flow-engine/index.ts` that evaluates the gate (flow key + non-interactive + success) and calls `pi.shutdown()`.
- **API:** consumes the existing `ExtensionActions.shutdown()` ("Gracefully shutdown pi and exit. Available in all contexts."), the `ctx.hasUI` signal from `session_start` (already used to pick TUI vs headless adapter), and the existing `flow:complete` event payload (`FlowResult` with `flowName` + `status`). No new events, no new settings.
- **Docs:** `docs/flow-authoring.md` (new `auto_end` key) and `docs/flows.md` (behavior + non-interactive gate).
- **Ordering note:** `flow:complete` fires after the summary widget mounts; because auto-end is gated to non-interactive sessions there is no visible summary to skip.
