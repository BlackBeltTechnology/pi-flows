# DOX — extensions

Files in this area. Purposes left for the agent to author.

| `autonomous-mode.ts` | Global autonomous toggle. `isAutonomousMode()` / `setAutonomousMode(enabled)`; persists `autonomousMode` key in `~/.pi/agent/providers.json`; `activate()` bootstraps state from disk. |
| `file-tracker.ts` | Counts main-session `edit`/`write` tool results → `getFileStats()` returns `{fileCount, insertions, deletions}`; `onFileStatsChange(cb)` notifies; `session_start` clears. |
| `flow-footer.ts` | `ctx.ui.setFooter` composable status line: provider·model, `⎇` git branch, file stats, context bar. Registry via `flow:register-footer-segment`; refresh on `model_select`, `turn_end`, `flow:complete`. |
| `index.ts` | Single pi-flows entry point. Default `activate(pi)` calls each sub-`activate` in fixed order, sharing one jiti module graph; re-exports `FlowHardError` + `CodeNodeContext`/`CodeNodeHandler`. |
