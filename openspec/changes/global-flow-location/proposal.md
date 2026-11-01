# Proposal: global-flow-location

## Why

pi loads skills from the project (`.pi/skills/`) **and** from the user's agent directory (`~/.pi/agent/skills/`), so one skill serves every folder. pi-flows has no user-level equivalent: flows and agents come only from the project (`.pi/flows/`), from packages that register directories by event, and from pi-flows built-ins. A personal, reusable flow (for example the OpenSpec `batch:apply` workflow written in invoice-bot) has to be copied into every project or wrapped in an npm package.

## What Changes

- **New user tier:** pi-flows discovers flows from `<agentDir>/flows/flows/<namespace>/<name>/flow.yaml` and agents from `<agentDir>/flows/agents/*.md`, where `<agentDir>` is pi's `getAgentDir()` (default `~/.pi/agent`, honours `PI_CODING_AGENT_DIR`).
- **Precedence on a name clash:** project > user > packages > built-ins. A project can still override a user flow or agent.
- **User flows run against the current project:** code handlers load from the flow's own directory; `ctx.cwd`, agents' working directory and results stay in the project the flow was started in.
- **Commands and listing:** user flows register as `/<namespace>:<name>` like project flows; `/flows` and `flow_agents list` show each item's source (`project`, `user`, `package`, `built-in`).
- **Authoring:** `flow_write` and `flow_agents` (op `write`) take an optional `scope: "project" | "user"`, default `project`.
- **Deleting:** `/flows:delete` deletes from the location the flow was found in and names that path in its confirmation.
- **Trust:** user flows load without project-trust gating, like user skills.

## Capabilities

### New Capabilities
- `user-flow-location`: the user-level flows and agents directory, its precedence, execution context of user flows, source labels, authoring scope and deletion.

### Modified Capabilities
<!-- none: the existing discovery requirements live in flow-bundle-layout and edit-mode; this change adds a tier without changing their requirements -->

## Impact

- **Code:** `extensions/flow-engine/discovery.ts` (new tier, source tags), `extensions/flow-engine/index.ts` (pass the user dir), `extensions/flow-engine/tools/flow-write.ts` and `tools/flow-agents.ts` (`scope`, source classification), `extensions/flow-context/index.ts` (`/flows` listing, `/flows:delete`).
- **Docs:** `docs/flow-authoring.md` discovery table, `README.md`, `CHANGELOG.md`.
- **Compatibility:** additive. Nothing changes for users without `~/.pi/agent/flows/`.
- **Enables:** installing a reusable `batch:apply` flow once per user (follow-up, outside pi-flows).
