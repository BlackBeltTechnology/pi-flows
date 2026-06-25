## Why

Code-node handlers are resolved by *reconstructing* a path from `cwd + flow.name` (`.pi/flows/handlers/<flow.name>/<id>.ts`), while the generator scaffolds templates by climbing relative to the YAML path. The two derivations disagree: the generator lands templates at `.pi/flows/flows/handlers/<frontmatter-name>/` while the runtime reads `.pi/flows/handlers/<namespace>:<name>/` (an extra `flows/` level, frontmatter-name vs the discovery-assigned colon command id). The colon directory is also Windows-hostile. The flow file already carries its own location (`FlowConfig.source`); resolving handlers relative to that single source of truth — and bundling each flow with its handlers in one directory — eliminates the entire drift class.

## What Changes

- **BREAKING (flow layout):** each flow becomes a self-contained directory. A flow is defined at `.pi/flows/flows/<namespace>/<name>/flow.yaml`, and its code handlers (`<id>.ts`, `<id>.ts.default`) live in the **same** directory. The previous flat layout (`.pi/flows/flows/<namespace>/<name>.yaml` + a parallel `.pi/flows/handlers/<flow>/` tree) is removed.
- **Source-relative handler resolution:** the executor and generator both resolve a convention handler as `join(dirname(flow.source), "<id>.ts")` (and `…/<id>.ts.default`), not a `cwd + name` reconstruction. This kills the depth/name drift at the root.
- **Discovery** derives the command id `<namespace>:<name>` from the directory structure (`<namespace>/<name>/flow.yaml`); `FlowConfig.source` is the path to `flow.yaml`.
- **`flow_write`** writes to `.pi/flows/flows/<namespace>/<name>/flow.yaml` (creating the dir); overwriting the same `<namespace>/<name>` edits in place.
- **Flow delete** removes the whole flow directory, so handlers can never be orphaned.
- **Clean break — no flat-layout fallback.** Discovery does NOT read the old `<name>.yaml` form or the old `.pi/flows/handlers/` tree. Flagged **BREAKING** in the CHANGELOG with a one-line migration note.
- Explicit `target:` is unchanged (still an author-owned path, resolved against `cwd`).

## Capabilities

### New Capabilities
- `flow-bundle-layout`: defines the per-flow directory layout (`.pi/flows/flows/<namespace>/<name>/flow.yaml` + co-located handlers), source-relative handler resolution via `dirname(flow.source)`, the directory-derived command id, delete-removes-directory, and the clean-break removal of the flat layout (no fallback).

### Modified Capabilities
- `code-node`: the "Handler location convention with target override" requirement changes from the reconstructed `.pi/flows/handlers/<flow>/<id>.ts` path to the flow-directory-relative `dirname(flow.source)/<id>.ts` (template `…/<id>.ts.default`); `target:` override unchanged.
- `flow-authoring`: the `flow_write` write-location scenario changes from `.pi/flows/flows/<namespace>/<name>.yaml` to `.pi/flows/flows/<namespace>/<name>/flow.yaml`.

## Impact

- **pi-flows code**: `execute-code-step.ts` (handler path → `dirname(flow.source)`; needs `flow.source` threaded in, replacing the `flowName`/`cwd` reconstruction), `flow-generate.ts` (`handlersDirFor` → flow dir; drop the `..` math), `tools/flow-write.ts` (write `<name>/flow.yaml`, mkdir the flow dir), `discovery.ts` (scan `<ns>/<name>/flow.yaml`, derive command id from dir structure, set `source`), flow delete command (rm the dir), `.pi/flows/handlers/` tree removed.
- **Skill/docs**: `skills/edit-flow/SKILL.md` + `docs`/`agent-docs` (handler path + write location) — the **Code handlers** and **Write locations** sections.
- **BREAKING**: existing flat flows + their `.pi/flows/handlers/` files stop being discovered; users move `<name>.yaml` → `<name>/flow.yaml` and drop handlers into that dir. CHANGELOG flags it.
- **No change** to step semantics, the failure model, template variables, or the `target:` override.
