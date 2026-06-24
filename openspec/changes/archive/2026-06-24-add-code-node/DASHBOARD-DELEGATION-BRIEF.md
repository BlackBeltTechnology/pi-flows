# Dashboard-side delegation brief — add-code-node

This change in `pi-flows` introduces a `code` step type — deterministic TypeScript running as a first-class DAG node with typed input/output wiring, just like agent steps. The pi-flows side handles parsing, validation, execution, and result mapping. The **dashboard owns the rendering** of code-node lifecycle and results.

Per the repo's architecture (`agent-docs/dashboard-integration.md`): pi-flows emits events and owns the engine contract; the dashboard owns the React reaction and the step card rendering for each step `kind`. This brief specifies the dashboard-side work as a **separate pi-agent-dashboard change**.

## Background: why code nodes need dashboard awareness

Code nodes are **not a different beast** — they fire the same step lifecycle events as agents (`onAgentStarted`, `onAgentComplete`, `onAssistantText`) and emit their results into the same merged result map. The **only distinction** is a `kind: "code"` discriminator on the events so the dashboard can:

1. Render a different visual icon/badge (code/terminal vs. agent/sparkles).
2. Show a different step card layout (code handlers have no tool calls, no thinking, no full-text agent output — only assistant text logged via `ctx.logger()`, a summary, and typed outputs).
3. Hyperlink the handler file path (when known at card render time).

All existing timelines, step history, and result extraction still work because code nodes wire into the same `result` map and event streams.

## Event contract (produced by pi-flows — do not change this)

Code nodes emit **identical lifecycle events** to agent nodes, carrying a `kind` discriminator. The step callback signatures are unchanged:

```typescript
interface StepLifecycleEvent {
  kind: "agent" | "code";  // ← discriminator
  name: string;             // node id
  stepIndex: number;
  stepId: string;
  taskIndex: number;
  ...rest unchanged
}
```

Event types emitted for code nodes:
- `flow:agent-started` — code node execution begins (use `kind: "code"` to style differently)
- `flow:assistant-text` — `ctx.logger()` call (stream to the step card like agent assistant text)
- `flow:agent-complete` — code node execution finishes; result available in merged map
- `flow:agent-error` — code node soft failure (routed `on_error` → target step, or hard-fails flow if unset)

**Existing reducer consumes these** — no new reducer logic needed. The `kind` field allows consumers to style/render them distinctly.

## Result contract (produced by pi-flows — do not change this)

On success, code nodes contribute to the merged result map:

```typescript
results[stepId] = {
  fullOutput: "...",                // JSON.stringify(outputs)
  status: "complete",
  summary: "...",                   // setSummary value or auto-generated
  artifacts: "",                    // always "" for code nodes
  files: "",                        // always "" for code nodes
  [typedOutputName]: "...",         // e.g., valid: "true", nav_record: "..."
  ...
}
```

**Consuming steps** already read these via template expansion `${{result.<stepId>.<key>}}` and do NOT care about `kind`. Conditionals also resolve typed outputs now (per the `conditional` typed-output-resolution requirement).

## Required change 1 — step card rendering (UI)

**File:** wherever pi-agent-dashboard renders step cards (`FlowStepCard.tsx` or equivalent). Add a new `kind:"code"` branch that renders a code node's step lifecycle differently:

- **Header icon**: show a code/terminal icon instead of (or in addition to) the agent sparkles icon.
- **Assistant text streaming**: code nodes log via `ctx.logger()` into `flow:assistant-text` events, just like agents. The existing assistant-text renderer should already handle these. Verify the card displays logged messages correctly.
- **Tool calls section**: code nodes have **no tool calls**. Omit the tool-call section for `kind:"code"` cards (or show a placeholder like "No tool calls").
- **Thinking section**: code nodes have **no thinking**. Omit the thinking section.
- **Summary section**: show the `summary` from the result (same as agent cards).
- **Typed outputs section**: show all typed-output keys and values in a `{ key: value }` display. Agents also have typed outputs now — this section benefits both.
- **Full output**: show `fullOutput` (JSON string of all outputs) in a collapsible detail section (same as agents).
- **Handler file link** (optional): if available in `result.handlerPath` (pi-flows will populate this when the handler path is known), hyperlink the handler file so the user can jump to the implementation.

No changes to timeline rendering, flow graph, fork cards, conditional routing, or dashboard-session integration — they all remain agnostic.

## Required change 2 — (optional) handler path in result

To enable hyperlink-to-implementation in the step card, pi-flows **will populate an optional `handlerPath` field** in the result:

```typescript
results[stepId] = {
  ...
  handlerPath?: string;  // e.g., ".pi/flows/handlers/research/validate-nav.ts"
}
```

This is **read-only for the dashboard** — pi-flows fills it, the dashboard uses it to offer a link/button ("📝 View handler"). If omitted or the path is inaccessible in the dashboard's context, the link is simply not shown.

This is a **convenience feature** and not required for v1 — it can be added after the core rendering is in place.

## Non-change: event mapping

**Do NOT add new entries to the dashboard's event map.** Code nodes use **existing event types** with a `kind` discriminator. The bridge's `FLOW_EVENT_MAP` (`packages/extension/src/bridge.ts`) is unchanged; `flow:agent-started`, `flow:assistant-text`, etc. still forward as-is. The dashboard's existing `reduceFlowEvent` reducer consumes them the same way.

## Testing considerations

- Unit test: code-node cards render correctly for a step with `kind:"code"` and valid `flow:assistant-text` events.
- Integration test: a code node in a running flow sends its lifecycle events and the dashboard card appears with the correct styling and no tool-call section.
- Regression test: agent node card rendering is unaffected (styling driven by `kind` remains backward compatible).

## Rollback

Remove the code-node rendering branch and the optional `handlerPath` field reader. Existing agent/fork/conditional rendering stays as-is.
