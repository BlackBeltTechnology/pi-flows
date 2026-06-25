# Tasks — Move flow keybindings to `alt+<letter>`

## 1. Abort + inspect → managed `alt+` shortcuts (`flow-tui.ts`)

- [x] 1.1 Register `flow.abort` (`Key.alt("x")`) via `pi.registerShortcut` in `setupFlowTui`, alongside the existing `alt+a`; handler aborts when `flowManager.isRunning`, else dismisses a mounted summary widget. Verify: `alt+x` aborts a running flow; no-op with nothing active.
- [x] 1.2 Register `flow.inspect` (`Key.alt("o")`); handler toggles passive ⇄ navigate on the mounted dashboard/summary; no-op when neither mounted. Verify: `alt+o` enters and exits navigate mode.
- [x] 1.3 Remove the `KEY_CTRL_O` / `KEY_CTRL_X` branches from `registerDashboardInputHandler` and `registerSummaryInputHandler` and the `session_start` `onTerminalInput` (keep arrows/Enter/Esc/Backspace capture). Delete now-unused `KEY_CTRL_O` / `KEY_CTRL_X` constants. Verify: `ctrl+o`/`ctrl+x` no longer trigger any flow action; `ctrl+o` only expands tool output.
- [x] 1.4 Update the comment block (L753, L960–962) to describe the `alt+x`/`alt+o` scheme.

## 2. Overlay thinking toggle → `alt+t` (`agent-detail-overlay.ts`)

- [x] 2.1 Replace `KEY_CTRL_T = "\x14"` trigger with the `alt+t` escape sequence (`"\x1bt"`); order the `handleInput` checks so two-byte `alt+t` is tested before the single-byte `ESC`-close branch. Verify: `alt+t` toggles thinking; bare `Esc` still closes the overlay.

## 3. Hint strings

- [x] 3.1 `flow-tui.ts` L908 footer: `"Ctrl+O inspect agents · Ctrl+X dismiss"` → `"alt+o inspect agents · alt+x dismiss"`.
- [x] 3.2 `flow-dashboard/agent-dashboard.ts` L274, L276: `Ctrl+X stop` / `Ctrl+O inspect` → `alt+x` / `alt+o`.
- [x] 3.3 `flow-dashboard/detail-view.ts` L174: `ctrl+t hide/show thinking` → `alt+t`.

## 4. README

- [x] 4.1 Keybindings table L83–84: `Ctrl+A` → `alt+a`, `Ctrl+X` → `alt+x`; add `alt+o` (inspect) and `alt+t` (toggle thinking) rows.
- [x] 4.2 L148 comment: `# used when Ctrl+A is active` → `alt+a`.

## 5. Docs (delegate to subagent per AGENTS.md)

- [x] 5.1 Update `docs/` keybinding references to the `alt+` scheme (human prose). (Only `docs/flows.md` `Alt+A`→`alt+a` casing; no ctrl refs existed.)
- [x] 5.2 Mirror into `agent-docs/` (caveman style) in the same task.

## 6. CHANGELOG + verification

- [x] 6.1 Add a CHANGELOG entry noting the breaking key change (`Ctrl+*` → `alt+*`) and that keys are rebindable via `keybindings.json`.
- [x] 6.2 `npm run lint && npm run typecheck && npm test` pass. (typecheck clean; lint 0 errors; 507/507 tests pass.)
- [ ] 6.3 Manual: in a TUI session with a running flow, confirm `ctrl+o`/`ctrl+t`/`ctrl+x` no longer double-fire and `alt+o`/`alt+t`/`alt+x`/`alt+a` work. (Requires interactive TUI — owner to verify.)
