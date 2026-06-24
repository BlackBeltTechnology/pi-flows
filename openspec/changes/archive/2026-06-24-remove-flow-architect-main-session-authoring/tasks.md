## 1. Consolidate authoring tools (discovery-based, no raw paths)

- [x] 1.1 Add `flow_agents` tool (`op: list | write`): `list` returns the catalog (logic from `agent-catalog.ts`); `write` validates via `agent-validate.ts` and writes to `.pi/flows/agents/<name>.md`. No raw `path` param.
- [x] 1.2 Rework `flow_write` to take `namespace` (default `custom`), `name`, `content`; validate via `flow-validate.ts`; write to `.pi/flows/flows/<namespace>/<name>.yaml`; emit `flow:rediscover`. Remove the raw `path` param.
- [x] 1.3 Delete the now-unused `agent-catalog.ts` and `agent-write.ts` tool files (logic folded into `flow_agents`).
- [x] 1.4 Register `flow_agents` and `flow_write` on the main session in `flow-engine/index.ts` but keep them INACTIVE by default (exclude from active tool set); remove the `subagentOnlyPi` registration for these three tools.
- [x] 1.5 Verify validators (`agent-validate.ts`, `flow-validate.ts`) are unchanged and still invoked before any write.

## 2. Gating via the `flows.editFlow` setting

- [x] 2.1 At each `session_start`, read `flows.editFlow` (project `.pi/settings.json` when trusted overrides global `~/.pi/agent/settings.json`; top-level `flowsEditFlow` also accepted) and reconcile via `pi.setActiveTools()` — add `flow_agents`/`flow_write` when enabled, remove when not. Skill stays available as `/skill:edit-flow`.
- [x] 2.2 Confirm tools are absent from `pi.getActiveTools()` when the setting is off and present when on.

## 3. Ship the edit-flow skill

- [x] 3.1 Create `skills/edit-flow/SKILL.md` with valid frontmatter (`name: edit-flow`, descriptive `description`).
- [x] 3.2 Document agent frontmatter schema, flow YAML + the step types, minimal examples, discovery-based write locations, and how to fix common validation errors. Cover both create and edit (edit = read existing + rewrite).
- [x] 3.3 Include the three `model:` reference forms (`@role`, `provider/model[:thinking]`, bare `model-id`) with one example each and the preference rules (per flow-model-resolution spec).
- [x] 3.4 Add `skills/` to `package.json#files`; confirm pi discovers `/skill:edit-flow`.

## 4. Remove the flow-architect machinery

- [x] 4.1 Delete `agents/flow-architect.md`.
- [x] 4.2 Delete `extensions/flow-dashboard/architect-widget.ts` and `extensions/flow-engine/architect-ui-adapter.ts`.
- [x] 4.3 Delete `extensions/flow-workspace/staging.ts` and remove all staging references.
- [x] 4.4 Remove architect widget mount / keyboard / event routing in `flow-tui.ts` (~746-991) and the `flow-architect` key in `shared/flow-widget.ts:11`.
- [x] 4.5 In `flow-workspace/index.ts`: remove `handleNewFlow`/`handleEditFlow`, the architect spawn path, the SDK conversation-summary code, and all `flow:architect-*` emissions; remove the `flows:new-request` / `flows:edit-request` listeners.
- [x] 4.6 In `flow-context/index.ts`: delete the `/flows:new` and `/flows:edit` commands and their request emitters.
- [x] 4.7 Trim the `/flows` interactive menu to list / run / delete only; drop New/Edit entries and point users to the `flows.editFlow` setting.
- [x] 4.8 Grep the codebase for residual `architect` references and clean orphans; ensure no dangling imports.

## 5. Docs (delegate to subagents per AGENTS.md protocol)

- [x] 5.1 Update `docs/tools-reference.md` (and mirror `agent-docs/tools-reference.md`) for `flow_agents` + `flow_write`.
- [x] 5.2 Update `docs/flow-authoring.md` (and `agent-docs/`) for the setting-gated `edit-flow` skill workflow; remove architect references.
- [x] 5.3 Update `README.md` built-in-agents + command tables (drop flow-architect, `/flows:new`, `/flows:edit`; add `/skill:edit-flow` + the `flows.editFlow` setting).
- [x] 5.4 Update `docs/dashboard-integration.md` (and `agent-docs/`) to note `flow:architect-*` removal and the companion-repo coordination.

## 6. Dashboard coordination

- [x] 6.1 File/track a companion pi-agent-dashboard change to drop `flow:architect-*` entries from `FLOW_EVENT_MAP`. Confirm no replacement event is emitted from pi-flows. (pi-flows side confirmed: emits no `flow:architect-*`. Companion edits tracked separately — `packages/extension/src/flow-event-wiring.ts` lines 27-39 + `bridge.ts:821` `flow:architect-abort`.)

## 7. Verify

- [x] 7.1 `npm run typecheck` passes.
- [x] 7.2 `npm run lint` passes.
- [x] 7.3 Update/remove architect-related tests in `__tests__/`; add coverage for `flow_agents`, namespace-based `flow_write`, and the gating behavior; `npm test` passes.
- [~] 7.4 Manual smoke: with `flows.editFlow: true` the tools are active at session start; authoring a flow writes `.pi/flows/flows/custom/<name>.yaml` and it registers as `/custom:<name>`. **Deferred** — requires a live interactive pi session; to be verified manually post-merge. Covered indirectly by unit tests for the gating setting (`edit-flow-config.test.ts`) and the tools (`edit-flow-tools.test.ts`).
