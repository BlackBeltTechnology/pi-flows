# Remove flow-architect; Author Flows from the Main Session via a Shipped Skill

## Why

Flow/agent creation today is mediated by the **flow-architect** subagent (`agents/flow-architect.md`). `/flows:new` and `/flows:edit` spawn it (`extensions/flow-workspace/index.ts`, ~1027 lines): the workspace SDK-summarizes the conversation, loads the architect agent, stages files in `.pi/flows/.staging/`, runs the architect in a replan loop, and drives a ~1161-line preview widget (`extensions/flow-dashboard/architect-widget.ts`) through ~25 `flow:architect-*` lifecycle events plus ~150 lines of keyboard/event routing in `flow-tui.ts`.

This indirection hurts steerability: the human cannot directly shape the flow; they negotiate with an opaque planning agent through a dedicated TUI widget. The tools and validators the architect uses (`agent-validate.ts`, `flow-validate.ts`) are solid and reusable — the indirection is the problem, not the writing path.

The right model is **human-steered authoring in the session the user already controls**. pi natively turns a package's `skills/` directory into a `/skill:<name>` command (model- and user-invocable, progressive-disclosure). Ship a `edit-flow` skill that teaches the syntax, expose consolidated authoring tools to the main session, and gate those tools behind a `flows.editFlow` setting. The architect agent, its widget, its staging directory, and its event lifecycle all become unnecessary.

## What changes

Delete the flow-architect agent and its UI/event/staging machinery; give the main session direct, gated authoring capability backed by a shipped pi skill.

- **Ship a `edit-flow` skill** at `skills/edit-flow/SKILL.md`, auto-discovered by pi as `/skill:edit-flow`. One skill covers both create and edit (edit = read the existing file, then rewrite). Contents: agent frontmatter schema, flow YAML + step-type reference, minimal examples, target write locations, and how to fix common validation errors. Add `skills/` to `package.json` `files`.
  - This uses pi's **native** skill system (read via the normal `read` tool, progressive disclosure). It is independent of pi-flows' own `skill_read` tool + `flow:register-skills-dir`, which stay for the judo/subagent path.
- **Consolidate the three subagent-only tools into two discovery-based tools on the main session:**
  - `flow_agents` — `op: list | write`. `list` returns the agent catalog; `write` validates (`agent-validate.ts`) and writes to the discovered location `.pi/flows/agents/<name>.md`. Replaces `agent_catalog` + `agent_write`.
  - `flow_write` — `namespace` (default `custom`), `name`, `content`. Validates (`flow-validate.ts`) and writes to `.pi/flows/flows/<namespace>/<name>.yaml`, which auto-registers as the `/<namespace>:<name>` command (`discovery.ts:207`). Overwrite = edit; no separate edit tool.
  - **No raw `path` parameters.** The engine derives the canonical discovered location so flows/agents always land where they auto-register.
- **Gate the authoring tools behind the `flows.editFlow` setting.** Register `flow_agents` and `flow_write` but keep them inactive by default (not in any session's system prompt). At each `session_start`, read `flows.editFlow` from settings (project `.pi/settings.json` when trusted overrides global `~/.pi/agent/settings.json`; top-level `flowsEditFlow` also accepted) and reconcile via `pi.setActiveTools()`. Tools become live only when the setting is enabled. The skill stays available as `/skill:edit-flow`.
- **Remove flow-architect and its wiring:**
  - Delete `agents/flow-architect.md`.
  - Delete `extensions/flow-dashboard/architect-widget.ts`, `extensions/flow-engine/architect-ui-adapter.ts`, and `extensions/flow-workspace/staging.ts`.
  - Remove architect widget mount/keyboard routing in `flow-tui.ts` (~746-991) and the `flow-architect` key in `shared/flow-widget.ts:11`.
  - Remove the entire `flow:architect-*` event lifecycle, the architect spawn path, and the SDK conversation-summarization code in `flow-workspace/index.ts` (`handleNewFlow`/`handleEditFlow`). The main session already holds the conversation, so no summary is needed.
  - Delete the `/flows:new` and `/flows:edit` commands and their `flows:new-request` / `flows:edit-request` emitters in `flow-context/index.ts`.
- **Rework the `/flows` menu** (`flow-context`) to offer list / run / delete only; drop the New/Edit entries and point users to the `flows.editFlow` setting.
- **Docs:** update `tools-reference.md`, `flow-authoring.md`, `README.md` built-in-agents + command tables (both `docs/` and `agent-docs/`).

## Impact

- **Affected specs:** new `flow-authoring` capability (gated main-session tools `flow_agents` + `flow_write` controlled by the `flows.editFlow` setting, and the shipped `edit-flow` skill); removal of all architect-related behavior.
- **Affected code:** `flow-engine/index.ts` (tool registration → consolidate + gate), `flow-engine/tools/` (merge `agent-catalog`+`agent-write` → `flow_agents`; rework `flow-write` to namespace-based discovery), `flow-workspace/index.ts` (remove architect handlers, summary, staging), `flow-context/index.ts` (drop new/edit commands + menu entries), `flow-tui.ts`, `shared/flow-widget.ts`; deletes `agents/flow-architect.md`, `architect-ui-adapter.ts`, `flow-dashboard/architect-widget.ts`, `flow-workspace/staging.ts`. Adds `skills/edit-flow/SKILL.md` + `package.json` `files`.
- **Dashboard:** the architect widget and all `flow:architect-*` events are removed. pi-agent-dashboard must drop/ignore them (coordinate with companion repo). No replacement events are emitted — authoring appears as ordinary main-session tool calls.
- **Backward compatibility:** **breaking** for anyone depending on the flow-architect agent, the `flow:architect-*` events, or the `/flows:new` / `/flows:edit` commands. Authoring moves from agent-driven to gated main-session-driven via the `flows.editFlow` setting + `/skill:edit-flow`.
- **Out of scope:**
  - Changing the flow/agent file formats themselves.
  - The generic code node (separate change).
  - Auto-generating flows without human involvement (this change is about *more* human steering, not less).
  - pi-flows' own `skill_read` tool + `flow:register-skills-dir` (the judo/subagent skill path) — untouched.
