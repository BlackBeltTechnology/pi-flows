# DOX — extensions/flow-dashboard

Files in this area. Purposes left for the agent to author.

| `agent-card.ts` | `AgentCard` — bordered per-agent card: status spinner, label, role/resolvedModel line, last 3 tool calls, tokens/duration. `onToolCall`, `onComplete`, `render(width,theme,selected)`. |
| `agent-dashboard.ts` | `AgentDashboard` — grid widget state: `preloadAgents`, `onAgentStarted/Complete/ToolCall/Result/AssistantText/ThinkingText`; eventLog + spinner; renders header/breadcrumb/grid/footer. |
| `agent-detail-overlay.ts` | `createAgentDetailOverlay(opts)` — TUI Component over one agent's DetailEntry log; ↑↓ nav/scroll, Enter expand, Backspace/ESC close, alt+t toggle thinking. Uses renderDetailView + renderBox. |
| `box-renderer.ts` | `renderBox(BoxOptions)` — bordered box helper ┌─┐ │pad│ └─┘; opts width, theme, title, content, footer, separatorAfter. `padLine` via visibleWidth. |
| `breadcrumb.ts` | `renderBreadcrumb(workflow,currentIndex,stageDetail,width,theme)` — one-line stage pipeline: `✓ done → [current] → dim next`, truncated to width. |
| `card-registry.ts` | Metric registry Map: `registerMetric(name,factory)`, `initCardTypes()` seeds default/files/tests, `getCardRenderer(agentConfig)` resolves `card.metric`, falls back DefaultCard. |
| `default-card.ts` | `DefaultCard implements AgentCardRenderer` — no-op fallback renderer; `renderMetric` returns "" (no metric line). |
| `detail-view.ts` | `renderDetailView` + scroll API (`createDetailScrollState`, `moveUp`/`moveDown`, `toggleExpand`, `computeExpandedContentLines`) — wrap DetailEntry[] into virtual doc, slice viewport, expand tool I/O. |
| `files-card.ts` | `FilesCard implements AgentCardRenderer` — "files" metric: counts Read vs Write/Edit calls + words read; `renderMetric` → `N read · N written · Nk words`. |
| `flow-preview-overlay.ts` | `createFlowPreviewOverlay(opts)` — TUI overlay of full FlowConfig: steps by type, branches, loops (backwardBranches), Wiring DAG tree, legend; ↑↓ scroll, Backspace close. |
| `grid-component.ts` | `GridComponent` — lays AgentCard[] into `computeCols` cols (MIN_CARD_WIDTH 40, CARD_HEIGHT 8, GAP 1); pads short rows, selection index, exact-width lines. |
| `index.ts` | Extension entry — `activate(pi)`: `initCardTypes()` + `flow:register-card` / `flow:register-workflow` events; re-exports AgentDashboard, overlays, registries, types. |
| `tests-card.ts` | `TestsCard implements AgentCardRenderer` — "tests" metric: parses Jest/Vitest/pytest Bash output into passed/failed; `renderMetric` → `✓ N · ✗ N` else `N commands`. |
| `types.ts` | Dashboard type defs: `WorkflowStage`/`WorkflowDefinition`, `AgentCardRenderer` (onToolCall/onToolResult/onComplete/renderMetric), `CardStatus`, `CardData`. |
| `workflow-registry.ts` | `registerWorkflow(def)` pushes; `resolveWorkflow(flowName)` → `{workflow, stageIndex}`, most specific (fewest stages) match wins. |
