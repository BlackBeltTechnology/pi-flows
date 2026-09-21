# DOX — extensions/flow-summary

Files in this area. Purposes left for the agent to author.

| `index.ts` | Extension entry: `activate(pi)` hooks `flow:complete`; `computeStats`; writes `.pi/flows/results/<flowName>.md`/`.json`; emits `flow:summary-started`/`flow:summary-ready`; state via `getSummaryState`/`setSummaryState`, `getLastCards`. |
| `summary-render.ts` | Pure render helpers for post-flow summary widget: `renderFrozenCards` (frozen read-only `GridComponent` grid), `renderSummaryContent(opts: SummaryContentOpts)` stacks cards above `renderBox` per-agent lines + next-step. Unit-testable. |
