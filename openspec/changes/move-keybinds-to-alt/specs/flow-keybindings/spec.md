## ADDED Requirements

### Requirement: All flow keybindings live in the `alt+<letter>` namespace
The flow TUI SHALL bind its interactive actions to `alt+<letter>` keys and SHALL NOT bind any `ctrl+<letter>` key, so flow bindings do not collide with pi-ai's `ctrl+<letter>` editor/app defaults.

The default scheme SHALL be:

| Action | Default key |
|---|---|
| Toggle AUTO (autonomous) mode | `alt+a` |
| Abort running flow / dismiss summary | `alt+x` |
| Inspect — enter dashboard/summary navigate mode | `alt+o` |
| Toggle thinking in the agent-detail overlay | `alt+t` |

#### Scenario: No ctrl-letter binding remains
- **WHEN** the flow extension is active in a TUI session
- **THEN** no flow action is triggered by `ctrl+o`, `ctrl+t`, or `ctrl+x`
- **AND** pi-ai's `app.tools.expand` (`ctrl+o`), `app.thinking.toggle` (`ctrl+t`), and editor bindings fire without any duplicate flow action

#### Scenario: alt keys drive the same actions as before
- **WHEN** the user presses `alt+x` while a flow is running
- **THEN** the flow aborts, exactly as the former `Ctrl+X` did

### Requirement: Global flow triggers route through the keybinding manager
The abort and inspect triggers SHALL be registered via `pi.registerShortcut` with namespaced ids (`flow.abort` = `alt+x`, `flow.inspect` = `alt+o`), alongside the existing AUTO toggle (`alt+a`), so they are customizable in `keybindings.json` and parsed consistently across terminals.

#### Scenario: Binding is user-rebindable
- **WHEN** a user maps `flow.abort` to a different key in `keybindings.json` and runs `/reload`
- **THEN** the new key aborts the flow and `alt+x` no longer does

### Requirement: Global triggers are inert outside flow UI
The `flow.abort` and `flow.inspect` shortcuts SHALL act only when the corresponding flow UI is active; otherwise they SHALL be no-ops that do not consume the key for other handlers.

#### Scenario: Abort does nothing when no flow runs
- **WHEN** the user presses `alt+x` with no flow running and no summary mounted
- **THEN** nothing is aborted and no flow-side effect occurs

#### Scenario: Inspect does nothing without a dashboard or summary
- **WHEN** the user presses `alt+o` with no dashboard or summary widget mounted
- **THEN** no navigate mode is entered

### Requirement: Modal navigation keys are unchanged
Within navigate mode and the agent-detail overlay, the non-letter navigation keys (arrows, Enter, Esc, Backspace) SHALL continue to drive selection, open, and close as before. Only the colliding letter triggers move to `alt+<letter>`.

#### Scenario: Arrow navigation still works
- **WHEN** the user is in navigate mode and presses the arrow keys
- **THEN** the selected agent card changes as before

#### Scenario: Overlay thinking toggle on alt+t
- **WHEN** the agent-detail overlay is open and the user presses `alt+t`
- **THEN** thinking entries toggle visibility, and bare `Esc` still closes the overlay

### Requirement: On-screen hints and docs reflect the live bindings
All footer/hint strings, the README keybindings table, and the `docs/`/`agent-docs/` keybinding references SHALL show the `alt+<letter>` keys. The README SHALL no longer document `Ctrl+A` for AUTO (it is `alt+a`).

#### Scenario: Footer shows alt keys
- **WHEN** the dashboard or summary widget renders its hint footer
- **THEN** it shows `alt+o` / `alt+x` (and `alt+t` in the overlay), not `Ctrl+*`

#### Scenario: README documents the correct AUTO key
- **WHEN** a reader consults the README keybindings table
- **THEN** AUTO toggle is listed as `alt+a`, abort as `alt+x`, inspect as `alt+o`
