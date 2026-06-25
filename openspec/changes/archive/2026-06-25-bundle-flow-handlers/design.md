## Context

Two code paths derive a code-node handler location and disagree:
- **Executor** (`execute-code-step.ts:64`): `join(cwd, ".pi","flows","handlers", flowName, "<id>.ts")`, where `flowName = options.flow.name` — and `discovery.ts:194-210` overrides `flow.name` with the filesystem-derived colon command id (`<ns>:<name>`).
- **Generator** (`flow-generate.ts:37`): `join(dirname(yamlPath), "..", "handlers", flow.name)`, where `flow.name` is the *parsed frontmatter* name and the single `..` assumed the YAML sat at `.pi/flows/flows/<name>.yaml` (no namespace subdir).

Result: templates land at `.pi/flows/flows/handlers/<frontmatter-name>/` while the runtime reads `.pi/flows/handlers/<ns>:<name>/`. The flow already knows its own file location via `FlowConfig.source` (types.ts:119), which both paths ignore.

## Goals / Non-Goals

**Goals:**
- One handler location, derived once from the flow file's own directory.
- Self-contained flow directories (definition + handlers together).
- Eliminate the colon directory and the depth/name drift permanently.

**Non-Goals:**
- No back-compat shim for the flat layout (clean break, per decision).
- No change to step semantics, failure model, template vars, or `target:` override behavior.
- No change to the agent layout (`.pi/flows/agents/<name>.md` stays flat).

## Decisions

**D1 — Bundle each flow in its own directory.** `.pi/flows/flows/<namespace>/<name>/flow.yaml`, handlers (`<id>.ts`, `<id>.ts.default`) co-located in that directory. Filename is `flow.yaml` (singular), not `<name>.yaml` (avoids the redundant `<name>/<name>.yaml`) and not `flows.yaml`. Alternative (keep flat, just fix the two derivations to agree on the colon path) was rejected: it keeps the Windows-hostile colon directory and the parallel `handlers/` tree, and leaves handlers orphan-able on delete.

**D2 — Resolve handlers relative to `dirname(flow.source)`.** Both executor and generator compute `join(dirname(flow.source), "<id>.ts")`. `flow.source` is the path to `flow.yaml`, set at discovery and already present on `FlowConfig`. This makes the source path the single truth — no `cwd`+`name` reconstruction, no namespace-depth math, no frontmatter-vs-command-id divergence. The drift bug becomes structurally impossible.

**D3 — Command id from directory structure.** Discovery derives `<namespace>:<name>` from the `<namespace>/<name>/flow.yaml` directory path (the same slash→colon rule it already applies), and sets `FlowConfig.source` to the `flow.yaml` path. Arbitrary namespace nesting maps to multi-segment colon ids, consistent with today.

**D4 — Clean break, no fallback.** Discovery reads ONLY the bundled form. The flat `<name>.yaml` and the `.pi/flows/handlers/` tree are not read. Flagged BREAKING in the CHANGELOG with a one-line migration (`mv <name>.yaml <name>/flow.yaml`; move handlers into the dir). Alternative (read both during a transition) was rejected by decision — clean break.

**D5 — Delete removes the directory.** `/flows:delete` removes the flow's directory, so handlers cannot be orphaned. This replaces deleting a lone `<name>.yaml`.

**D6 — `target:` unchanged.** An explicit `target:` remains an author-owned path resolved against `cwd`; only the *convention* path moves to the flow directory.

## Risks / Trade-offs

- **[Existing flat flows stop being discovered]** → Clean break by decision; CHANGELOG documents the one-step migration. Pre-1.0, project-local scope keeps blast radius contained.
- **[`flow.source` not populated for a programmatically-constructed flow]** → Executor must fail loudly (clear error) if `flow.source` is empty when a convention handler is needed; `target:` remains the escape hatch. Add a test for the empty-source guard.
- **[`flow-ref` globs authored against `<name>.yaml`]** → Users repoint globs at `<name>/flow.yaml`; documented in the migration note.
- **[Extra directory nesting for code-less flows]** → Negligible; the self-containment win dominates.
