## Context

Flows run inside a parent pi session. When a flow reaches a terminal state, `FlowManager` clears `_activeFlow` and emits `flow:complete` with a `FlowResult` (`{ flowName, status: "complete" | "error" | "aborted", ... }`). Today nothing reacts to that for session lifecycle — the session stays open.

The motivating case is **automation-spawned sessions**: the dashboard fires `flow:run` on a fresh session; the flow runs to completion; the session then lingers forever, holding resources and cluttering the session list. There is no way to say "this run was the session's whole purpose — end it when done."

Three enabling primitives already exist:
- `flow:complete` — emitted after the flow reaches a terminal state (and after the summary widget mounts).
- `ExtensionActions.shutdown()` — documented as "Gracefully shutdown pi and exit. Available in all contexts."
- `ctx.hasUI` at `session_start` — already consumed by the engine to choose the TUI vs headless I/O adapter; the same signal distinguishes interactive from non-interactive sessions.

## Goals / Non-Goals

**Goals:**
- Let a flow opt in to closing its parent session on successful completion.
- Confine auto-close to non-interactive sessions so a watching human is never surprised.
- Reuse existing primitives (`flow:complete`, `shutdown()`, `ctx.hasUI`) — no new events, no new settings.
- Safe defaults: off unless the flow opts in; never on user-triggered abort; never interactive.

**Non-Goals:**
- A session-level consent setting (`flows.autoEnd`) — the non-interactive gate supplies the same protection; see D1.
- Interactive auto-close — explicitly out of scope for v1 (see D5).
- Continuing/resuming interrupted flows (out of scope; unrelated to lifecycle close).
- Queueing or multi-flow support.
- Closing a session mid-flow or on partial progress.
- Any dashboard-side UI (dashboard already spawns sessions; it needs no change to benefit).

## Decisions

### D1 — Gate: flow key AND non-interactive session
Auto-end fires only when `flow.yaml` `auto_end: true` **and** the session is non-interactive (`!ctx.hasUI`). Rationale: the only case where an unwanted close causes harm is an interactive human session; gating to non-interactive removes that case entirely. A committed `auto_end` flow can therefore only ever close a headless/automation session — exactly the intended consumer.
- *Alternative considered:* a second session-level consent setting (`flows.autoEnd`). Rejected — it and the non-interactive gate guard the same thing (closing without a watching human's consent); the non-interactive gate does it without an extra config surface, reader file, or trusted-project precedence logic (AGENTS.md: no configurability that wasn't requested).
- *Alternative considered:* flow key alone (no interactivity gate). Rejected — running an `auto_end` flow interactively via `/ns:flow` would close the operator's live session by surprise.
- *Alternative considered:* non-interactive gate alone (auto-close all headless flows). Rejected — a headless session may deliberately run a flow and then act on the result; the explicit flow opt-in preserves that.

### D2 — Success-only by default; never on abort
The gate passes only for `status === "complete"`. `status === "aborted"` MUST never trigger auto-end (the user just pressed `alt+x`; they are present). `status === "error"` does not trigger auto-end by default (operator likely wants to inspect).
- *Alternative considered:* close on any terminal status. Rejected — aborting to keep the session and then having it close is hostile; error auto-close hides failures.

### D3 — Listener lives in the flow-engine extension
The `flow:complete` handler is registered in `extensions/flow-engine/index.ts` alongside the existing `flow:abort`/`flow:run` handlers. It looks up the completed flow's config (from the `flows` map) to read `auto_end`, checks the session is non-interactive, checks status, then calls `pi.shutdown()`.

### D4 — Non-TUI detection via `ctx.mode` (NOT `hasUI`)
The eligibility condition is `ctx.mode !== "tui"`, captured at `session_start`. **`hasUI` is the wrong signal**: it is documented as "true in TUI *and RPC* modes," and the dashboard automation spawns its runs in **RPC** mode — so a `!hasUI` gate misclassifies every dashboard automation run as interactive and never fires, defeating the feature's primary use case. `ctx.mode` distinguishes a local terminal (`tui`, human present → do not close) from programmatic runs (`rpc`/`json`/`print` → eligible). The listener consults a cached `sessionMode`. Because auto-end never fires in `tui`, the fact that `flow:complete` arrives after the summary widget mounts is moot — non-TUI sessions have no visible summary, so no grace period is needed for v1.

## Risks / Trade-offs

- **Accidental interactive close** → impossible by construction: the non-interactive gate (D1) means an interactive session is never a shutdown target regardless of the flow key.
- **Race: shutdown before persistence flush** → `flow:complete` already fires after the run reaches terminal state and after summary context is set; `shutdown()` is graceful. Verify persistence has flushed before shutdown in tests.
- **`shutdown()` availability assumption** → typed as "available in all contexts," but confirm it is reachable from the extension's `pi` handle at the point the listener runs (session_start wiring).
- **`hasUI` timing** → the listener must read the flag captured at `session_start`, not before it; ensure wiring order (session_start caches `isInteractive` before any flow can complete).

## Migration Plan

Purely additive and opt-in. No migration: existing flows and sessions are unaffected because `auto_end` defaults to absent/false. Rollback = remove the flow key (or revert the listener); no persisted state to unwind.

## Open Questions

1. **Error status:** never auto-end on `error`, or make it a future opt-in (`auto_end: on_success | always`)? v1 leans never.
2. **Reachability of `shutdown()`** from the `pi` object the flow-engine holds — confirm during implementation via the faux-model harness.
3. **Future escape hatch:** if interactive auto-close is ever requested, re-introduce a narrowly-scoped `flows.autoEnd` setting whose sole role is to *permit* auto-end interactively — not as a general consent key. Out of scope for v1.
