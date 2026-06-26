## 1. Failing test (TDD)

- [x] 1.1 Add `__tests__/flow-summary-rendering.test.ts` asserting the summary widget render output includes preserved card content above the per-agent summary lines, given a `lastCards` snapshot.
- [x] 1.2 Add a test case asserting graceful fallback: when one agent has no card in the snapshot, the render still includes that agent's summary line and does not throw.
- [x] 1.3 Run `npm test` and confirm the new tests FAIL for the right reason (cards not yet rendered).

## 2. Render frozen cards in the summary widget

- [x] 2.1 In `flow-tui.ts` `flow:summary-ready` renderer (~L806), add a card-render pass above the existing summary-lines pass, driving a static read-only render from `getLastCards()`. (Extracted to `renderSummaryContent` in `extensions/flow-summary/summary-render.ts`.)
- [x] 2.2 Reuse `GridComponent` (or its render output) from `extensions/flow-dashboard/grid-component.ts` for the frozen grid layout; ensure no live-update/dispose lifecycle is wired.
- [x] 2.3 Null-check each card (`getLastCards()?.get(name)`) and fall back to the summary line when absent, matching the navigate-mode guard (~L859).

## 3. Preserve existing summary layers

- [x] 3.1 Confirm the per-agent summary lines, next-step hint, and footer (`alt+o inspect · alt+x dismiss`) still render beneath the cards unchanged.
- [x] 3.2 Confirm `alt+o` still opens the per-agent detail overlay (full tool history) — no keybinding or navigate-mode regression (navigate mode + input handlers untouched).

## 4. Verify

- [x] 4.1 Run `npm test`, `npm run typecheck`, `npm run lint` — all pass (300 tests, 0 type errors, 0 lint errors).
- [x] 4.2 Manual TUI smoke: run a multi-agent flow, confirm frozen cards appear above summaries on completion, and `alt+o` reaches the detail overlay. (Requires interactive terminal — left for user.)
