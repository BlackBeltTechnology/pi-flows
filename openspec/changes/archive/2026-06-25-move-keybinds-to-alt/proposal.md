# Move all flow keybindings to the `alt+<letter>` namespace

## Why

pi-flows binds three terminal keys via **raw `onTerminalInput` handlers** that match
control bytes directly (`\x0f`, `\x14`, `\x18`), bypassing pi's `KeybindingsManager`:

- `Ctrl+O` (`\x0f`) — enter dashboard/summary navigate ("inspect") mode (`flow-tui.ts`)
- `Ctrl+X` (`\x18`) — abort running flow / dismiss summary (`flow-tui.ts`)
- `Ctrl+T` (`\x14`) — toggle thinking in the agent-detail overlay (`agent-detail-overlay.ts`)

These were added before pi-ai claimed the same keys as **global app defaults**. Today they
collide and double-fire:

| Flow key | pi-ai current default | Effect |
|---|---|---|
| `Ctrl+O` inspect | `app.tools.expand` (global) | both fire |
| `Ctrl+T` thinking | `app.thinking.toggle` (global) | both fire |
| `Ctrl+X` abort | `app.models.clearAll` (model selector only) | lower risk, still wrong namespace |

The `AUTO` toggle already proved the fix: it was migrated `Ctrl+A` → `alt+a` via
`pi.registerShortcut` because the editor consumed `ctrl+a` for `cursorLineStart`. pi-ai's
`alt+<letter>` space is nearly empty (only editor word-motions: `alt+b/f/d/y` plus
`alt+left/right/up/enter/backspace/delete`); `alt+a/o/x/t` are all free.

Raw control-byte handlers are also **not rebindable** via `keybindings.json`, so users
cannot escape the clash themselves.

## What changes

Move every flow keybinding into the `alt+<letter>` namespace and route the global
triggers through pi's `KeybindingsManager` (mirroring the existing `alt+a`), so they no
longer collide with pi-ai's growing `ctrl+<letter>` defaults and become user-rebindable.

| Action | Old | New |
|---|---|---|
| Toggle AUTO mode | `alt+a` (already migrated) | `alt+a` (unchanged) |
| Abort flow / dismiss summary | `Ctrl+X` | `alt+x` |
| Inspect (enter navigate mode) | `Ctrl+O` | `alt+o` |
| Toggle thinking (detail overlay) | `Ctrl+T` | `alt+t` |

- Global triggers (`abort`, `inspect`) move from raw `onTerminalInput` byte-matching to
  `pi.registerShortcut` with namespaced ids and context guards, so they are inert when no
  flow UI is active and are customizable in `keybindings.json`.
- Modal navigation that does **not** collide with pi letter-bindings (arrows, Enter, Esc,
  Backspace within navigate/overlay capture) stays as-is.
- The detail-overlay thinking toggle moves `Ctrl+T` → `alt+t`.
- All footer/hint strings and the README keybindings table update to the new keys.
- README is also **corrected**: it still documents `Ctrl+A` for AUTO even though the code
  already uses `alt+a`.

## Impact

- **Affected specs:** new `flow-keybindings` capability (the default key scheme +
  registration contract + context-guard behavior).
- **Affected code:**
  - `extensions/flow-engine/flow-tui.ts` — `KEY_CTRL_O`/`KEY_CTRL_X` raw handling →
    `registerShortcut(alt+o / alt+x)` with context guards; footer hint at L908; comments.
  - `extensions/flow-dashboard/agent-detail-overlay.ts` — `KEY_CTRL_T` → `alt+t`.
  - `extensions/flow-dashboard/agent-dashboard.ts` — hint strings (L274, L276).
  - `extensions/flow-dashboard/detail-view.ts` — thinking hint (L174).
  - `README.md` — keybindings table (L83–84) + L148 comment.
  - `agent-docs/` + `docs/` keybinding references (delegated to subagent per AGENTS.md).
- **Backward compatibility:** the bound keys change. Mitigated because the new keys are
  rebindable; document the change in CHANGELOG. No public API change.
- **Out of scope:**
  - Reclaiming `ctrl+o`/`ctrl+t` by overriding pi defaults (the open override-vs-stack
    question) — sidestepped entirely by moving to `alt+`.
  - Dashboard (browser) keybindings in pi-agent-dashboard — separate repo/surface.
  - Re-theming or restructuring the dashboard/summary navigation model.
