## Why

On pi ≥ 0.80.8 (including pi 1.x), `createAgentSession` ignores the old `authStorage` and `modelRegistry` options and only accepts `modelRuntime`. pi-flows never passes the parent session's runtime in production, so every flow agent session gets a fresh disk-only runtime. Providers that exist only in the parent session's memory are missing from it. That covers anything registered through `pi.registerProvider()`: the dashboard's `proxy`/`local` providers from `providers.json`, or any user extension in a plain TUI session. A flow agent on such a model resolves correctly, then fails on its first request with "No API key found" / "Unknown provider".

Second, the no-dashboard fallback resolves models via `pi.modelRegistry`, which the pi 1.x extension API object does not have (it only exists on `ctx`). Without a `model:resolve` handler, every flow agent therefore fails with "Model registry unavailable", even for plain `anthropic/...` refs.

Separately, pi 1.x adds a `max` thinking level that pi-flows does not recognise. `provider/model:max` is read as a model id, so the lookup fails.

## What Changes

- Flow agent sessions SHALL use the parent session's model runtime (providers + API keys), captured at `session_start` and passed to every `createAgentSession` call, including fork-decision and `agent-decision` (loop) agents.
- The model is **not** inherited. Every agent must still name its model (`model:resolve` first, then the parent's registered models). A missing, wrong, or unresolvable model still fails. Model resolution is unchanged.
- The no-dashboard fallback SHALL resolve models through the session's registry (`ctx.modelRegistry` from `session_start`) instead of the non-existent `pi.modelRegistry`. Resolution order and failure behaviour are unchanged.
- When no parent runtime is available (programmatic `runFlow` with no session), the option is omitted and pi's default disk runtime is used, the same as today.
- Remove dead plumbing: the `authStorage` capture (always `undefined` on pi 1.x) and the `authStorage`/`modelRegistry` run options that pi no longer reads. `flow:get-spawn-context` gains `modelRuntime` and drops `authStorage`.
- Accept `max` as a thinking level (frontmatter `thinking:` and `:max` suffix), and update the documented level lists.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `subagent-spawn`: the `modelRuntime` requirement changes from "forward one if available" to "the parent session's runtime SHALL be supplied in production runs", with a real-registry scenario for a runtime-registered provider.
- `flow-model-resolution`: the fallback resolves via the session's registry. The accepted thinking levels gain `max`.

## Impact

- Code: `extensions/flow-engine/index.ts` (capture the runtime, spawn-context event), `flow-manager.ts`, `flow-execution.ts` (three option pass-through sites), `execution.ts`, `model-roles.ts` (thinking levels), `types.ts` (comment).
- Tests: new real-`ModelRegistry` test in `__tests__/`.
- Docs: `docs/flow-authoring.md`, `docs/agents.md`, `.pi/skills/manage-flows/SKILL.md` (levels), `docs/architecture.md` (runtime inheritance).
- Relies on pi's private `ModelRegistry.runtime` field until pi exposes a public accessor. See design.md.
- Downstream: `flow:get-spawn-context` consumers should read `modelRuntime`. Dashboard comment and spec update tracked separately in pi-agent-dashboard.

## Discipline Skills

`doubt-driven-review` (relies on a private pi field), `systematic-debugging` if the manual proxy-model check disagrees with the analysis.
