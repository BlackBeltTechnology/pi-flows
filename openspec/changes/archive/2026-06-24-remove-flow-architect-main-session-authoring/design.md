## Context

Flow/agent authoring is mediated by the **flow-architect** subagent. `/flows:new` and `/flows:edit` (registered in `flow-context/index.ts`) emit `flows:new-request` / `flows:edit-request`, which `flow-workspace/index.ts` (~1027 lines) handles by: SDK-summarizing the conversation, loading `agents/flow-architect.md`, staging files in `.pi/flows/.staging/`, spawning the architect in a replan loop, and driving a ~1161-line preview widget (`flow-dashboard/architect-widget.ts`) via ~25 `flow:architect-*` events plus ~150 lines of routing in `flow-tui.ts`.

The writing/validation core is sound: `agent-validate.ts`, `flow-validate.ts`, and the three subagent-only tools (`agent_catalog`, `agent_write`, `flow_write`). The indirection — the agent, widget, staging, and event lifecycle — is what blocks human steering.

pi natively turns a package's `skills/` directory into a `/skill:<name>` command (model- and user-invocable, progressive-disclosure, read via the normal `read` tool). pi also supports runtime tool registration and `pi.setActiveTools()` for enabling/disabling tools mid-session. These two facts make a skill-driven, gated, main-session authoring model viable without the architect.

Constraints:
- Skills are markdown injected into context — they **cannot execute code**, so tool activation needs a code trigger.
- Flow command names derive from on-disk location: `.pi/flows/flows/<subdir>/<name>.yaml` → `/<subdir>:<name>` (`discovery.ts:207`).
- pi-flows' own `skill_read` tool + `flow:register-skills-dir` (the judo/subagent skill path) is a **separate** mechanism and stays untouched.

## Goals / Non-Goals

**Goals:**
- Author and edit flows/agents conversationally in the main session the user already controls.
- Ship a single `edit-flow` skill (native pi skill) that teaches the syntax and is invocable as `/skill:edit-flow`.
- Reduce the writing surface to two discovery-based tools (`flow_agents`, `flow_write`) with no raw paths.
- Keep the authoring tools out of every session's prompt by default; activate them only on opt-in.
- Delete the architect agent, widget, adapter, staging, summary, and event lifecycle.

**Non-Goals:**
- Changing the flow/agent file formats.
- Auto-generating flows without human involvement (the change is about *more* steering).
- The generic code node (separate change).
- Touching pi-flows' own `skill_read` / `flow:register-skills-dir` judo path.
- Emitting replacement dashboard events for authoring.

## Decisions

### D1 — Native pi skill, not the pi-flows skill_read path
Ship `skills/edit-flow/SKILL.md` and add `skills/` to `package.json#files`. pi auto-discovers package `skills/` dirs and exposes `/skill:edit-flow`; descriptions sit in the system prompt, full content loads on `read` / `/skill:`. One skill covers create AND edit (edit = `read` the existing file, then rewrite).

*Alternative considered:* register the content through pi-flows' own `flow:register-skills-dir` + `skill_read` tool. Rejected — that path is for subagents and requires the model to know the `skill_read` tool; the native path gives a first-class `/skill:` command and standard progressive disclosure for free.

### D2 — Consolidate 3 tools → 2, discovery-based, no raw paths
- `flow_agents` (`op: list | write`): `list` returns the catalog (former `agent_catalog`); `write` validates via `agent-validate.ts` and writes to the discovered location `.pi/flows/agents/<name>.md`. Replaces `agent_catalog` + `agent_write`.
- `flow_write` (`namespace` default `custom`, `name`, `content`): validates via `flow-validate.ts` and writes to `.pi/flows/flows/<namespace>/<name>.yaml`, which auto-registers as `/<namespace>:<name>`. Overwrite = edit.

The raw `path` parameter was an artifact of the staging model. The engine now derives the canonical discovered location, guaranteeing authored artifacts land where they auto-register.

*Alternative considered:* keep three single-purpose tools with an added `namespace`. Rejected — the user asked to minimize prompt overhead; merging catalog+write under `flow_agents` and dropping the separate edit path cuts the surface.

### D3 — Gate via the `flows.editFlow` setting at session_start
Register `flow_agents` and `flow_write` at activation but keep them **inactive** by default. At each `session_start`, read the `flows.editFlow` boolean from settings and reconcile the active set with `pi.setActiveTools()` — add the two tools when enabled, remove them when not. Project `.pi/settings.json` is honored only for trusted projects and overrides the global `~/.pi/agent/settings.json`; default is disabled. The `edit-flow` skill stays available as `/skill:edit-flow` regardless. (A top-level `flowsEditFlow` boolean is also accepted as an alias.)

*Alternatives considered:* (a) always-on (2 tools, low overhead) — rejected, user wanted gating; (b) a thin `/flows:author` command that activates the tools and primes the skill — implemented first, then **replaced** at user request with the settings flag (config opt-in, no per-session command); trade-off is that flipping it requires a session restart.

### D4 — Delete the architect machinery wholesale
Remove `agents/flow-architect.md`, `flow-dashboard/architect-widget.ts`, `flow-engine/architect-ui-adapter.ts`, `flow-workspace/staging.ts`, the `flow-architect` key in `shared/flow-widget.ts`, the architect widget/keyboard/event routing in `flow-tui.ts`, and the architect spawn path + SDK conversation-summary code + `flow:architect-*` emissions in `flow-workspace/index.ts`. Delete `/flows:new` and `/flows:edit` commands and their request emitters in `flow-context/index.ts`. The main session already holds the conversation, so no summary step is needed.

### D5 — Dashboard: drop events, coordinate companion repo, emit nothing new
All `flow:architect-*` events are removed. Authoring now appears as ordinary main-session tool calls, so no replacement event is emitted. pi-agent-dashboard must drop/ignore `flow:architect-*` (cross-repo coordination). The `dashboard-event-emission` spec's two architect requirements are removed.

## Risks / Trade-offs

- **[Breaking change for dashboard observers]** → Removing `flow:architect-*` breaks any consumer keyed on them. Mitigation: coordinate a companion pi-agent-dashboard change to drop `FLOW_EVENT_MAP` architect entries; document in `dashboard-integration.md`.
- **[Breaking change for users of `/flows:new` / `/flows:edit`]** → Those commands disappear. Mitigation: README + `/flows` menu point to the `flows.editFlow` setting and `/skill:edit-flow`; CHANGELOG calls out the migration.
- **[Model may not load the skill before writing]** → Without the architect's structured loop, the LLM could call `flow_write` with malformed YAML. Mitigation: `/skill:edit-flow` teaches the format; `flow_write`/`flow_agents` validate before writing and return diagnostics for self-correction (existing behavior preserved).
- **[Loss of staged preview/replan UX]** → No more approve/replan widget. Mitigation: writes go to disk via validated tools and are visible as normal file changes the user can inspect/revert; iteration happens conversationally.
- **[Tool-gating leaves tools unusable until the setting is enabled]** → Acceptable by design — that is the opt-in. The skill (when loaded) and `/flows` menu surface the `flows.editFlow` entry point. Flipping the setting requires a session restart.

## Migration Plan

1. Add `skills/edit-flow/SKILL.md`; add `skills/` to `package.json#files`.
2. Consolidate tools (`flow_agents`, `flow_write`) with discovery-based writes; register inactive.
3. Gate the tools behind the `flows.editFlow` setting (reconcile active set at `session_start`).
4. Delete architect agent, widget, adapter, staging, summary, events; delete `/flows:new` / `/flows:edit`; trim `/flows` menu.
5. Update docs (`tools-reference.md`, `flow-authoring.md`, `README.md`, `dashboard-integration.md`) in both `docs/` and `agent-docs/`.
6. Coordinate companion pi-agent-dashboard change to drop `flow:architect-*` from `FLOW_EVENT_MAP`.

Rollback: revert the change set; the architect path is self-contained and restorable as a unit.

## Open Questions

- Exact default `namespace` value — `custom` is assumed (matches existing `discovery.ts` behavior). Confirm during implementation if a different default is preferred.
- Whether to also offer a runtime toggle (command/keybinding) so enabling authoring does not require a session restart. Deferred — the setting is the chosen opt-in surface.
