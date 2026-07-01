## 1. Emit structured details catalog

- [x] 1.1 In `extensions/flow-engine/tools/flow-agents.ts` `op:"list"`, after building `catalog`, build `detailsAgents = catalog.map(...)` producing flat entries `{ name, description, source_type, source_path?, tools?, inputs?, outputs? (names), use_when }` where `use_when = architect?.use_when ?? description`; omit absent optional fields.
- [x] 1.2 Return `details: { count: catalog.length, agents: detailsAgents }` instead of `details: {}`; keep `content[0].text` unchanged.

## 2. Tests

- [x] 2.1 Add/extend a tool test: `op:"list"` with a discovered set → `details.count === N`, `details.agents.length === N`, each entry has `name`+`description`+`source_type`.
- [x] 2.2 Assert a no-`architect` agent's entry `use_when === description`, and a built-in entry omits `source_path`.
- [x] 2.3 Assert `content[0].text` still parses to the same catalog array (text unchanged).

## 3. Verify

- [x] 3.1 `npm test` green; `npm run typecheck` (tsc --noEmit) exit 0.
- [x] 3.2 `npm run reload` + dashboard sanity-check 2014 VERIFIED LIVE: flow_agents op:list card shows 7-agent expandable list with populated details (screenshot).
