## Context

`flow_agents op:"list"` (in `extensions/flow-engine/tools/flow-agents.ts`) builds a `catalog` array with per-agent fields (`name, description, tools, inputs, outputs, card, source_type, source_path, architect`) and returns `{ content:[{type:"text", text: JSON.stringify(catalog,null,2)}], details: {} }`. `details` is empty. Consumers that line-truncate large text results (pi-agent-dashboard) lose the catalog.

## Goals / Non-Goals

**Goals:**
- Emit a structured, flat, display-friendly catalog in `details` (never line-truncated).
- Keep `content[0].text` byte-for-byte compatible (model channel unchanged).

**Non-Goals:**
- `op:"write"`, `flow_write`, tool gating, discovery — untouched.
- No new dependency; no change to `AgentConfig`.

## Decisions

**Decision 1 — `details = { count, agents[] }` flat shape.** Map the existing `catalog` into a display-friendly entry: `{ name, description, source_type, source_path?, tools?, inputs?, outputs?, use_when }`. `outputs` flattened to names (`agent.outputs?.map(o => o.name)`). `use_when = agent.architect?.use_when ?? agent.description`. Rationale: consumers get a stable flat contract without knowing the nested `architect`/`AgentOutput` shapes. Alternative: dump the raw catalog into `details.agents` — rejected, leaks nested shapes and the `card`/full-architect blob the display does not need.

**Decision 2 — Omit absent optional fields.** Only spread `source_path`/`tools`/`inputs`/`outputs` when present/non-empty (mirrors the existing text-catalog conditionals). Keeps entries lean and lets consumers duck-type.

**Decision 3 — Reuse the single catalog loop.** Build `details.agents` in the same pass that builds the text `catalog` (or map from it after) to avoid a second discovery walk.

## Risks / Trade-offs

- [Text/details divergence] The text keeps nested `architect`; details flattens `use_when`. Accepted — text is the model channel, details the display channel; both derive from the same source in one pass.
- [Consumer relies on details before deploy] Backward compatible: text unchanged, `details` additive. Older consumers ignore `details`.

## Migration Plan

Edit the tool, `npm run reload` to refresh connected sessions. Rollback = revert the `op:"list"` branch.

## Open Questions

None.
