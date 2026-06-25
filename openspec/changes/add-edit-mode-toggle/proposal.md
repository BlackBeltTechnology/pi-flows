# Add Edit-Mode Toggle (tools + skill visibility, with live reload)

## Why

Flow/agent authoring is gated by the `flows.editFlow` setting, which activates the `flow_agents`/`flow_write` tools at `session_start` (`index.ts:332`). But two problems remain:

1. **No way to flip it from inside a session.** A user must hand-edit `.pi/settings.json` and start a new session. There is no command, and no programmatic entry for the dashboard.
2. **The `edit-flow` skill's visibility is not coupled to the toggle.** Whether the AI *sees* a skill in its prompt is controlled solely by `disable-model-invocation` in the skill's SKILL.md frontmatter (`skills.d.ts:6`) — there is no per-skill settings flag. So even with `editFlow` on, the AI is not told the authoring skill exists; and with it off, nothing hides it. The two halves (tools, skill) drift apart.

We want one switch: **edit-mode on → the AI sees the `edit-flow` skill AND has the authoring tools; edit-mode off → neither.** And flipping it must take effect **immediately** (live reload), not at the next manual restart.

## What changes

Add a single edit-mode toggle, reachable from both the TUI and the dashboard, that updates the setting, syncs the skill's model-visibility, and reloads in place.

- **Command** `/flows:edit-mode <on|off>` (TUI) and **event** `flow:set-edit-mode { enabled }` (dashboard) converge on one handler that:
  1. writes `flows.editFlow = enabled` to the project `.pi/settings.json`;
  2. ensures a **project-local** skill copy exists at `.pi/skills/edit-flow/SKILL.md` (materialized from pi-flows' packaged template);
  3. writes `disable-model-invocation: <!enabled>` into that project-local copy's frontmatter;
  4. triggers a live reload so skills are re-discovered and frontmatter re-parsed (`ctx.reload()`), and the tool gating re-runs;
  5. notifies the user.
- **Project-local skill ownership.** pi-flows materializes and owns `.pi/skills/edit-flow/SKILL.md`. The toggle never writes into `node_modules` (the packaged `skills/edit-flow/` is read-only and reinstall-volatile). This is the writable, per-project, natively-discovered location.
- Result: `enabled=true` → frontmatter `disable-model-invocation: false` → the AI sees the skill; tools active. `enabled=false` → `true` → the AI does not see it (still reachable via explicit `/skill:edit-flow`); tools inactive. One reload, immediate effect.

## Impact

- **Affected specs:** new `edit-mode` capability (command + event + the settings/skill-sync/reload contract); a touch to `dashboard-event-emission` to document the inbound `flow:set-edit-mode` event.
- **Affected code:** `extensions/flow-engine/edit-flow-config.ts` (write helper), `extensions/flow-engine/index.ts` (command + event registration, reuse `session_start` tool reconcile), a small skill-materialization helper, `extensions/flow-context/index.ts` (command surface alongside `/flows:*`).
- **Cross-repo:** pi-agent-dashboard gains a UI affordance that emits `flow:set-edit-mode` (consumes the existing event channel; no pi-flows-side coupling).
- **Backward compatibility:** additive. The setting semantics are unchanged; the toggle is a new way to set it. Default stays `false`.
- **Out of scope:**
  - Auto-enabling edit-mode for projects that contain flows (deliberately not automatic).
  - The `pi.skills` package-manifest discovery fix (separate concern; this change manages a project-local copy instead).
  - Global (`~/.pi/agent/settings.json`) toggling — this change targets the project setting + project-local skill (correct per-project scope and trust model).
