## Why

pi-flows treats a role ref like `@fast` as a hard requirement: if no `model:resolve` handler answers (pi-agent-dashboard not installed) or the role is not assigned, the agent step fails. Roles are a dashboard feature, so pi-flows effectively depends on the dashboard — including its own built-in `flow-decision` agent (`model: "@fast"`), which every autonomous fork without an `agent:` uses. pi-flows also hard-codes a role-name list in its validator and teaches role names in its docs, although it should not know which roles exist.

Separately, flow execution throws away the `Model` object the resolver returned and re-looks the id up in the registry — a second resolution that can fail after the first one succeeded. And decisions can only be customised step by step: there is no project- or flow-wide way to choose the agent that makes autonomous decisions.

This change replaces the deleted, pi-0.80-era `fix-flow-agent-model-resolution`; only its still-valid part (use the resolved `Model` directly) is carried over.

## What Changes

- **Roles become optional, legacy refs keep working.** A single `model: @fast` / `model: @coding` stays valid and behaves exactly as today when a resolver resolves it. When the `@`-ref cannot be resolved (no resolver, or the resolver reports an error such as "not assigned"), the agent falls back instead of failing.
- **Optional ordered model list.** `model:` also accepts a list (`[@fast, anthropic/claude-haiku-4-5]`); the first entry that resolves is used. Unresolvable `@`-refs are skipped; a literal ref that is not found is an error (never skipped silently).
- **Session-model fallback, configurable.** When no entry resolves, or the agent has no `model:` at all, the agent runs on the dispatching session's model (snapshot at flow start), with a visible warning. A new setting `flows.modelFallback: "session" | "error"` (default `session`) lets strict deployments fail instead.
- **System-wide decision agent.** Decision steps pick their agent from: step `agent:` → flow-level `decision_agent:` → setting `flows.decisionAgent` → built-in `flow-decision`. `agent-decision` steps may now omit `agent:` (like `fork` already can).
- **Built-in agents keep their role refs** (`flow-decision` keeps `@fast`, `project-context-reader` keeps `@coding`) and now work without the dashboard via the fallback.
- **No role knowledge in the validator.** The hard-coded role list and its warning are removed; only syntax is checked.
- **Write-time resolution is advisory.** `flow_agents` write emits `model:resolve` for `@`-refs and reports a resolver error as a warning that names the fallback that will apply.
- **Use the resolved `Model` directly**, including through the pre-resolution step in `flow-execution.ts`.
- **Docs and skill** stop listing role names, document single/list/omitted `model:`, the fallback and its setting, the `decision_agent:` / `flows.decisionAgent` selection, and the `model:resolve` resolver contract.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `flow-model-resolution`: unresolvable `@`-refs fall back (list → session model) instead of failing, governed by `flows.modelFallback`; `model:` accepts single refs, an ordered list, or nothing; validation is role-agnostic; write-time resolution is advisory; the resolved `Model` is used directly; the authoring skill no longer prefers or lists roles.
- `decision-routing`: the agent used for a decision step is selected via step → flow `decision_agent:` → `flows.decisionAgent` → built-in `flow-decision`; `agent-decision` steps may omit `agent:`.

## Impact

- **Code**: `extensions/flow-engine/model-roles.ts` (fallback chain, list support), `extensions/flow-engine/agent-parser.ts` (`model` optional / list), `extensions/flow-engine/types.ts` (`AgentConfig.modelRefs`, `FlowConfig.decision_agent`), `extensions/flow-engine/tools/agent-validate.ts`, `extensions/flow-engine/tools/flow-agents.ts`, `extensions/flow-engine/index.ts` (parent-model snapshot, settings), `extensions/flow-engine/execution.ts` + `flow-execution.ts` (Model hand-off, decision-agent selection), `extensions/flow-engine/flow-parser-yaml.ts` (`decision_agent`, optional `agent` on `agent-decision`), a small settings reader next to `edit-flow-config.ts`.
- **Compatibility**: non-breaking. Every agent that resolves today resolves identically. Previously failing cases (unresolvable `@`-ref) now succeed on the session model unless `flows.modelFallback: "error"`. `AgentConfig.model` stays a `string` (first ref, or `undefined` when omitted); the full list is a new `modelRefs` field.
- **Cost note**: a fallback may run a "fast" helper on the (possibly more expensive) session model; the fallback is reported on the agent-started event and card, and strict setups use `flows.modelFallback: "error"`.
- **Docs**: `docs/events-api.md`, `docs/agents.md`, `docs/flow-authoring.md`, `docs/flows.md`, `skills/manage-flows/SKILL.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md` (docs/ via subagent per AGENTS.md).

## Discipline Skills

`doubt-driven-review` (fallback semantics and the new `AgentConfig.modelRefs` field), `systematic-debugging` if the Model hand-off regresses.
