# Require explicit `type:` on every flow step

## Why

The flow YAML parser currently makes `type:` optional. When it's absent, `parseStep` calls `inferStepType(raw)`, which guesses the step type from which fields are present (`question:` → fork, `path:` → flow-ref, `branches:` → agent-decision, `agent:` → agent) and **falls back to `agent` when nothing matches** (`flow-parser-yaml.ts:79,109`).

This inference is a silent-failure footgun:

- A typo'd discriminator (e.g. `questoin:`) or a stray `branches:` silently reclassifies a step. The flow still validates and then does the wrong thing at runtime.
- `code` and `code-decision` are already *un-inferrable* — `code` has no unique field and collides with the `agent` fallback; `code-decision` collides with `agent-decision` on `branches:`. So authors already must declare `type:` for those two. The result is an asymmetric rule ("sometimes infer, except these two") that authors and the `edit-flow` skill have to memorize.
- A malformed agent step (author forgot `agent:`) falls through to the `agent` fallback and throws a confusing downstream error instead of a clear "missing type" message.

Making `type:` mandatory everywhere removes the footgun, makes every flow file self-describing for reviewers, and collapses the rule to one line: **every step declares its `type:`**.

## What changes

- **Parser:** `flow-parser-yaml.ts` — remove the `inferStepType` fallback. When a step has no `type:` field, throw an error naming the step `id` and listing the valid types. Delete the now-dead `inferStepType` function. Keep the existing migration errors for the removed `conditional` / `agent-loop-decision` types, but key them off the explicit `type:` value only.
- **Tests:** add explicit `type:` to the inline-YAML steps that currently rely on inference — `bundle-layout.test.ts`, `code-decision.test.ts`, `code-node-validation.test.ts`, `edit-flow-tools.test.ts`. Add a test asserting a type-less step is rejected with a clear error.
- **Docs:** rewrite the "type is optional — engine infers…" sections in `docs/flow-authoring.md` (≈355–377) and the corresponding rows in `docs/flows.md` to state that `type:` is required on every step. (Delegated to a docs subagent per AGENTS.md.)
- **Skill:** update `.pi/skills/edit-flow/SKILL.md:185` to drop "Step type is usually inferred…" and instead instruct that every step MUST declare `type:`.

## Impact

- **Affected specs:** `decision-routing` — MODIFY the "Canonical step-type set" requirement to mandate an explicit `type:` on every step.
- **Affected code:** `extensions/flow-engine/flow-parser-yaml.ts` only (one inference site, one dead function).
- **Affected tests:** `bundle-layout`, `code-decision`, `code-node-validation`, `edit-flow-tools` (add `type:` lines); plus a new rejection test.
- **Affected docs/skill:** `docs/flow-authoring.md`, `docs/flows.md`, `.pi/skills/edit-flow/SKILL.md`.
- **Backward compatibility:** **Breaking** for any flow YAML that omits `type:` on a step. No committed flow files exist in the repo (flows are authored at runtime into `.pi/flows/flows/…`), so there is no in-repo migration; runtime-authored flows that relied on inference must add `type:`. The error message lists valid types to make migration mechanical.
- **Out of scope:**
  - Normalize-on-write (injecting resolved `type:` during `flow_write`) — a separate, non-breaking ergonomics idea.
  - Adding a discriminator field to make `code` inferrable — not pursued; explicit `type:` is the chosen direction.
