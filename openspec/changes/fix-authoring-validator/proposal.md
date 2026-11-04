# Proposal: fix-authoring-validator

## Why

The batch run of 2026-11-01 lost two finished agent results and skipped a whole merge step. All four batch agents declared an output named `status`; the finish tool has its own `status` field (`complete` means success), so `status: "done"` silently made a successful step a failure and routed it to `on_error`. Nothing warned the author. Editing the agent file did not help either, because the running session kept the agent definitions it discovered at start.

An earlier audit found more cases where the validator rejects valid flows, accepts invalid ones, or silently drops fields:

- `tools: []` in the built-in `flow-decision.md` fails its own validation.
- `${{flow.input.X}}` is wrongly rejected.
- Inline `inputs`/`outputs` lists are silently dropped.
- The `card.type` warning fires for a field the parser ignores.
- `on_error` is silently dropped on `fork` and `agent-decision`.
- `flow_write` describes the wrong write path and does not sanitize `name`.
- Fork branch keys are not checked against `options`.
- `object`/`array` agent outputs validate but are not delivered as such.

## What Changes

- **Reserved output names:** an agent output named `status`, `summary`, `files` or `artifacts` (the finish tool's own fields), or `branch` on a decision agent, is a validation **error** naming the field and suggesting a rename (e.g. `outcome`).
- **Fresh definitions per run:** agents and flows are re-discovered at the start of every flow run, so edits to agent or flow files apply to the next run without `/reload`.
- **Validator fixes:**
  - `tools: []` is valid and means "no tools".
  - `${{flow.input.<name>}}` is accepted when the flow declares that input.
  - Inline list `inputs:`/`outputs:` are parsed, or rejected with an error if the form is unsupported; never dropped.
  - The `card.type` warning is removed for fields the parser ignores, or the field is honoured.
  - `on_error` on `fork` and `agent-decision` is honoured, or rejected with an error; never dropped.
  - Fork `branches` keys must be members of `options` (error naming the stray key).
  - Agent outputs of `type: object|array` are rejected until delivered as typed values.
- **`flow_write`:** its description states the real path (`.pi/flows/flows/<namespace>/<name>/flow.yaml`), and `name`/`namespace` must match `^[a-z0-9][a-z0-9-]*$` (error otherwise; no path traversal).

## Capabilities

### New Capabilities
- `authoring-validation`: reserved output names, fresh discovery per run, and the validator corrections listed above.

### Modified Capabilities
<!-- none: the existing flow-authoring and agent-node requirements stay; this change adds validation rules -->

## Impact

- **Code:** `tools/agent-validate.ts`, `tools/flow-validate.ts`, `agent-parser.ts`, `flow-parser-yaml.ts`, `tools/flow-write.ts`, `index.ts` (rediscover at run start), `flow-execution.ts` (`on_error` on fork / agent-decision if honoured).
- **Behaviour change:** agents declaring a reserved output name stop validating. That is intended, because they were broken.
- **Docs:** `docs/agents.md`, `docs/flow-authoring.md`, `CHANGELOG.md`.

## Discipline Skills

`systematic-debugging` (verify each audit item against current code before fixing; some may already be fixed by `resolver-agnostic-model-refs` or `classifier-decisions`), `security-hardening` (`flow_write` name sanitizing).
