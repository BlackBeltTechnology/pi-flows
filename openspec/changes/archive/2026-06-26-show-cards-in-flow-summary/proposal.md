## Why

When a flow completes, the live dashboard grid is disposed and replaced by a compact summary box that shows only each agent's truncated `r.summary` string. The rich agent cards — built up live during the run and already snapshotted into `lastCards` on completion — are thrown away from view, reachable only by pressing `alt+o` to step through them one at a time. Now that the cards are persisted across the live→summary transition, hiding them wastes information the user already paid to compute.

## What Changes

- The post-flow summary widget SHALL render the preserved agent cards (from the `lastCards` snapshot) in their grid layout, frozen/read-only, above the existing summary lines.
- The summary lines (per-agent finish `summary`, next-step hint, footer) SHALL remain below the cards as the scannable TL;DR.
- `alt+o` SHALL continue to open the per-agent detail overlay (full tool history) — the deep drill-in the static card cannot show.
- No overflow cap is introduced in this change; the grid renders at its natural height. (Bounding tall grids is deferred until it demonstrably bites.)

## Capabilities

### New Capabilities
- `post-flow-summary-rendering`: defines what the post-flow summary widget displays after a flow completes — frozen agent cards in grid layout, the summary lines beneath them, and the relationship to the `alt+o` detail overlay.

### Modified Capabilities
<!-- None. flow-keybindings (alt+o = inspect) and dashboard-event-emission (summary lifecycle events) are unchanged; this change only alters what the summary widget renders. -->

## Impact

- `extensions/flow-summary/index.ts` — the `flow:summary-ready` payload already carries everything needed; no change expected unless card data must be threaded through.
- `extensions/flow-engine/flow-tui.ts` — the `flow:summary-ready` widget renderer (`setupFlowTui`, ~L806) gains a frozen-grid render pass above the summary lines, reusing the `lastCards` snapshot via `getLastCards()`.
- `extensions/flow-dashboard/grid-component.ts` — `GridComponent` reused in a static read-only pass; no live updates.
- No event-contract or keybinding changes. `onFlowComplete` still disposes the live dashboard and snapshots cards exactly as today (Option A: re-render the snapshot, not keep the live grid mounted).
