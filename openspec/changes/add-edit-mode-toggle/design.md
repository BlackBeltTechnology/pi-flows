## Context

`flows.editFlow` already gates the `flow_agents`/`flow_write` tools, reconciled at `session_start` (`index.ts:332`, `edit-flow-config.ts:isEditFlowEnabled`). What's missing: an in-session way to flip it, coupling of the `edit-flow` skill's model-visibility to the same switch, and immediate effect. pi core gives us the primitives: per-skill visibility via `disable-model-invocation` frontmatter (`skills.d.ts:6`; skills with it `true` are excluded from the prompt and only invocable via `/skill:name`), and live `ctx.reload()` (`extensions/types.d.ts:275`) which re-discovers skills and re-parses frontmatter.

## Goals / Non-Goals

**Goals**
- One toggle, from TUI **and** dashboard, that sets `flows.editFlow`, syncs the skill's model-visibility, and takes effect immediately.
- No mutation of installed package files.

**Non-Goals**
- Auto-enable on flow-bearing projects.
- Fixing package-skill auto-discovery (`pi.skills`) — orthogonal.
- Global-scope toggling.

## Decisions

### D1 — Project-local skill ownership (never write node_modules)
The packaged skill resolves to `node_modules/pi-flows/skills/edit-flow/SKILL.md` — read-only, reinstall-volatile, and shared across projects. The toggle therefore operates on a **project-local copy** at `.pi/skills/edit-flow/SKILL.md` that pi-flows materializes from its packaged template on first need. This is writable, per-project (matches the trust model), survives reinstalls, and is the location pi core natively discovers.

### D2 — Couple skill visibility to the setting via `disable-model-invocation`
There is no per-skill settings flag. The only lever for "AI sees it or not" is the frontmatter `disable-model-invocation`. The handler writes `disable-model-invocation: <!enabled>` into the project-local copy: `enabled` ⇒ `false` (AI sees it), disabled ⇒ `true` (hidden from prompt, still reachable via explicit `/skill:edit-flow`).

### D3 — Single source of truth for the skill
To avoid the skill being discovered twice (package copy via any future `pi.skills` manifest AND the project-local copy), the **project-local copy is authoritative** for the main session. The packaged copy stays read-only and is used only by pi-flows' internal `skill_read`/subagent injection path.

### D4 — Live reload after writes
After writing settings + frontmatter, the handler calls `ctx.reload()` to re-discover skills and re-parse frontmatter; the existing `session_start` reconcile re-gates the tools (a reload fires the session lifecycle with `reason: "reload"`). No manual restart.

### D5 — Command has reload; event must borrow a command context
`reload()` is on `ExtensionCommandContext` (`types.d.ts:241,275`), and command handlers receive that type (`:773`). Plain `pi.events.on(...)` handlers receive only a payload, **not** a command context. Therefore:
- The `/flows:edit-mode` command calls `ctx.reload()` directly.
- The `flow:set-edit-mode` event handler performs the file writes, then obtains reload via a command-capable context captured at `session_start` (the same place we already capture session handles in `index.ts`), or by routing to the command. Implementation MUST verify the captured context exposes `reload()`; if unavailable, fall back to notifying the user that the change applies next session.

### D6 — Settings write is a direct file write
pi core exposes no `ExtensionAPI.writeSetting`. pi-flows writes the project `.pi/settings.json` itself (read-merge-write JSON, preserving other keys), consistent with it already owning flow/agent/skill file writes.

## Risks / Trade-offs

- **Event-path reload (D5)** is the main unknown — mitigated by the capture/fallback strategy and an explicit verification task.
- **Two copies of the skill** (package + project-local) — mitigated by D3 (project-local authoritative; don't manifest the package copy for the main session).
- **Settings-file write races** with a user hand-editing the file — low risk; read-merge-write minimizes clobbering.
- **Materialization staleness** — the project-local copy can drift from an updated packaged template; acceptable (re-materialize on version change is a possible follow-up, not required).

## Migration Plan

Additive. Existing `flows.editFlow` semantics unchanged; the toggle is a new writer. First toggle materializes `.pi/skills/edit-flow/SKILL.md`. Projects that never toggle are unaffected.

## Open Questions

- Does the `session_start`-captured context expose `reload()` for the event path, or must the event route through the command? (Resolved during implementation per D5.)
