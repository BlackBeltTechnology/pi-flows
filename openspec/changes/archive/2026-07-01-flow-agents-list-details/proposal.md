## Why

`flow_agents op:"list"` returns the agent catalog only as pretty-printed JSON in `content[0].text`, with an empty `details: {}`. Dashboards and other consumers line-truncate large text tool results, so the catalog is lost for display (the pi-agent-dashboard card could not show the agents). The structured catalog belongs in the non-truncated `details` channel so consumers get an authoritative, machine-readable list independent of text truncation.

## What Changes

- `flow_agents op:"list"` SHALL populate `details` with `{ count, agents: [...] }` in addition to the existing `content[0].text` (text payload unchanged — it remains the model channel).
- Each `details.agents` entry SHALL carry `name`, `description`, `source_type`, and, when present, `source_path`, `tools`, `inputs`, `outputs` (names), and `use_when` (flattened from `architect.use_when`, falling back to `description`).
- No change to `op:"write"`, `flow_write`, tool gating, or discovery.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `flow-authoring`: the `flow_agents op:"list"` contract gains a structured `details` catalog alongside the existing text result.

## Impact

- **Code**: `extensions/flow-engine/tools/flow-agents.ts` (`op:"list"` branch).
- **Tests**: `__tests__` covering the tool — assert `details.agents`/`details.count`.
- **Consumers**: pi-agent-dashboard `FlowAgentsToolRenderer` reads `details` (its own linked change `flow-agents-readable-list`). Backward compatible — text output unchanged.
- Requires `npm run reload` for connected sessions to pick up the new tool output.
