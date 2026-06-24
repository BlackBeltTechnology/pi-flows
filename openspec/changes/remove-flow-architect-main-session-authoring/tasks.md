## 1. Consolidate authoring tools (discovery-based, no raw paths)

- [ ] 1.1 Add `flow_agents` tool (`op: list | write`): `list` returns the catalog (logic from `agent-catalog.ts`); `write` validates via `agent-validate.ts` and writes to `.pi/flows/agents/<name>.md`. No raw `path` param.
- [ ] 1.2 Rework `flow_write` to take `namespace` (default `custom`), `name`, `content`; validate via `flow-validate.ts`; write to `.pi/flows/flows/<namespace>/<name>.yaml`; emit `flow:rediscover`. Remove the raw `path` param.
- [ ] 1.3 Delete the now-unused `agent-catalog.ts` and `agent-write.ts` tool files (logic folded into `flow_agents`).
- [ ] 1.4 Register `flow_agents` and `flow_write` on the main session in `flow-engine/index.ts` but keep them INACTIVE by default (exclude from active tool set); remove the `subagentOnlyPi` registration for these three tools.
- [ ] 1.5 Verify validators (`agent-validate.ts`, `flow-validate.ts`) are unchanged and still invoked before any write.

## 2. Gating command + skill priming

- [ ] 2.1 Add `/flows:author` command that calls `pi.setActiveTools([...current, "flow_agents", "flow_write"])` and primes the `flow-authoring` skill in one shot.
- [ ] 2.2 Confirm tools are absent from `pi.getActiveTools()` before `/flows:author` and present after.

## 3. Ship the flow-authoring skill

- [ ] 3.1 Create `skills/flow-authoring/SKILL.md` with valid frontmatter (`name: flow-authoring`, descriptive `description`).
- [ ] 3.2 Document agent frontmatter schema, flow YAML + the step types, minimal examples, discovery-based write locations, and how to fix common validation errors. Cover both create and edit (edit = read existing + rewrite).
- [ ] 3.3 Include the three `model:` reference forms (`@role`, `provider/model[:thinking]`, bare `model-id`) with one example each and the preference rules (per flow-model-resolution spec).
- [ ] 3.4 Add `skills/` to `package.json#files`; confirm pi discovers `/skill:flow-authoring`.

## 4. Remove the flow-architect machinery

- [ ] 4.1 Delete `agents/flow-architect.md`.
- [ ] 4.2 Delete `extensions/flow-dashboard/architect-widget.ts` and `extensions/flow-engine/architect-ui-adapter.ts`.
- [ ] 4.3 Delete `extensions/flow-workspace/staging.ts` and remove all staging references.
- [ ] 4.4 Remove architect widget mount / keyboard / event routing in `flow-tui.ts` (~746-991) and the `flow-architect` key in `shared/flow-widget.ts:11`.
- [ ] 4.5 In `flow-workspace/index.ts`: remove `handleNewFlow`/`handleEditFlow`, the architect spawn path, the SDK conversation-summary code, and all `flow:architect-*` emissions; remove the `flows:new-request` / `flows:edit-request` listeners.
- [ ] 4.6 In `flow-context/index.ts`: delete the `/flows:new` and `/flows:edit` commands and their request emitters.
- [ ] 4.7 Trim the `/flows` interactive menu to list / run / delete only; drop New/Edit entries and point users to `/flows:author`.
- [ ] 4.8 Grep the codebase for residual `architect` references and clean orphans; ensure no dangling imports.

## 5. Docs (delegate to subagents per AGENTS.md protocol)

- [ ] 5.1 Update `docs/tools-reference.md` (and mirror `agent-docs/tools-reference.md`) for `flow_agents` + `flow_write`.
- [ ] 5.2 Update `docs/flow-authoring.md` (and `agent-docs/`) for the skill-driven `/flows:author` workflow; remove architect references.
- [ ] 5.3 Update `README.md` built-in-agents + command tables (drop flow-architect, `/flows:new`, `/flows:edit`; add `/flows:author`, `/skill:flow-authoring`).
- [ ] 5.4 Update `docs/dashboard-integration.md` (and `agent-docs/`) to note `flow:architect-*` removal and the companion-repo coordination.

## 6. Dashboard coordination

- [ ] 6.1 File/track a companion pi-agent-dashboard change to drop `flow:architect-*` entries from `FLOW_EVENT_MAP`. Confirm no replacement event is emitted from pi-flows.

## 7. Verify

- [ ] 7.1 `npm run typecheck` passes.
- [ ] 7.2 `npm run lint` passes.
- [ ] 7.3 Update/remove architect-related tests in `__tests__/`; add coverage for `flow_agents`, namespace-based `flow_write`, and the gating behavior; `npm test` passes.
- [ ] 7.4 Manual smoke: `/flows:author` activates tools + primes skill; authoring a flow writes `.pi/flows/flows/custom/<name>.yaml` and it registers as `/custom:<name>`.
