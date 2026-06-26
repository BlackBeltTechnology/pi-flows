## Context

The flow lifecycle has two TUI phases. **During the run**, `flow-dashboard`'s `GridComponent` renders live agent cards. **On completion**, `onFlowComplete` (flow-tui.ts ~L807) snapshots the cards (`lastCards = new Map(this.dashboard.getAllCards())`) and the tool history, then disposes the live dashboard and tears down its widget. The snapshot is shared with the summary extension via `flow:set-summary-context` and reachable through `getLastCards()`. `flow:summary-ready` then mounts the `flow-summary` widget (a renderer registered in `setupFlowTui`, ~L806), which today renders only the per-agent `r.summary` strings (truncated) plus a next-step hint and footer. The cards survive in `lastCards` but are only surfaced via `alt+o` navigate mode, one agent at a time.

## Goals / Non-Goals

**Goals:**
- Render the preserved cards in grid layout, frozen, above the existing summary lines in the post-flow summary widget.
- Reuse the existing snapshot (`getLastCards()`) and grid renderer — no new event plumbing.
- Keep `alt+o` as the route to the deep per-agent detail overlay.

**Non-Goals:**
- Keeping the live `GridComponent` mounted past completion (rejected — see Decisions). We re-render the snapshot.
- Bounding/scrolling tall grids. No overflow cap in this change.
- Changing event contracts (`dashboard-event-emission`) or keybindings (`flow-keybindings`).

## Decisions

**Decision: Re-render the snapshot (Option A), not keep the live grid mounted (Option B).**
`onFlowComplete` already snapshots `lastCards` and disposes the dashboard for clean teardown. Option B (leaving the live `GridComponent` mounted and appending a summary box) would leave two widgets with two input handlers competing for keys (`alt+o`, `alt+x`, arrows). Option A keeps a single widget (`flow-summary`) owning input, and reuses the static snapshot. *Alternative considered:* Option B — rejected for input-ownership complexity and lifecycle surgery in `onFlowComplete`.

**Decision: Render the frozen cards via the existing grid layout, not stacked full-height cards.**
The grid already packs N agents into columns; reusing it keeps the multi-agent case compact and visually consistent with the run. The summary widget's renderer (in `setupFlowTui`'s `flow:summary-ready` handler) gains a card-render pass above the current summary-lines pass, driving a static read-only `GridComponent` (or its render output) from `getLastCards()`. *Alternative considered:* one tall card per agent stacked vertically — rejected as it overflows fast.

**Decision: No overflow cap yet.**
Render the grid at natural height. If a 6+ agent flow overflows the terminal in practice, a follow-up change adds a cap (`+N more — alt+o`). Encoding a cap now is speculative.

**Decision: Keep the summary lines and `alt+o` detail overlay.**
The summary lines are the scannable TL;DR; the cards are the at-a-glance detail; the `alt+o` overlay is the deep tool-history drill-in the static card cannot show. All three layers stay.

## Risks / Trade-offs

- **Tall grids overflow the terminal (no cap).** → Accepted for now; deferred to a follow-up if it bites in practice. Most flows have few agents.
- **Reusing `GridComponent` in a static pass may assume live-update state.** → Render read-only from the snapshot; do not wire any update/dispose lifecycle. Verify the renderer is side-effect-free when driven once.
- **Card snapshot may be missing for an agent.** → Spec requires graceful fallback to the summary line; the renderer must null-check `getLastCards()?.get(name)` (the navigate-mode code already does this at flow-tui.ts ~L859).

## Open Questions

- Should the frozen cards render their full body or a compact variant when the grid is tall? Left to implementation feel; default to the same body as the run unless it clearly overflows in testing.
