# Decoupling Strategies — pi-flows for Dashboard Integration

## Current State Summary

See [tui-coupling-analysis.md](./tui-coupling-analysis.md) for the detailed audit.

**TL;DR:** Flow execution and the architect (new/edit) workflows are already
decoupled via events. The remaining coupling is in the **CRUD command handlers**
(`/flows`, `/flows:delete`, `/flows:edit`, `/flows:new` in flow-context) and
`/roles` / `/provider` (in role-manager). These use `ctx.ui.select()`,
`ctx.ui.confirm()`, `ctx.ui.input()`, and `ctx.ui.notify()` directly.

---

## Strategy A: Extend emitPromptAndAwait to Command Handlers

**The pattern already exists** — flow-workspace uses `emitPromptAndAwait()` for
all user interaction during architect workflows. Extend this pattern to the
CRUD command handlers.

### How it works today (flow-workspace):

```
flow-workspace                    flow-prompt.ts              Adapters
─────────────                     ──────────────              ────────
                                                              
handleNewFlow()                                               
  │                                                           
  ├─→ emitPromptAndAwait(pi, {                                
  │     type: "input",                                        
  │     question: "Describe..."                               
  │   })                                                      
  │     │                                                     
  │     ├─→ emit("flow:prompt-request", {...})  ─────→ TUI adapter
  │     │                                        ─────→ Dashboard adapter
  │     │                                                     
  │     └─← on("flow:prompt-response", {...})  ←───── First to respond wins
  │                                                           
  └─→ continues with answer                                   
```

### What we'd change:

Convert flow-context command handlers to use `emitPromptAndAwait` instead of
`ctx.ui`:

```typescript
// BEFORE (flow-context/index.ts)
handler: async (args, ctx) => {
  const confirmed = await ctx.ui.confirm(`Delete flow "${name}"?`, "");
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "warning");
    return;
  }
  // ... delete
}

// AFTER  
handler: async (args, ctx) => {
  // The command handler becomes a thin wrapper that emits events
  pi.events.emit("flows:delete-request", { flowName: name });
}

// New event handler (no ctx.ui dependency)
pi.events.on("flows:delete-request", async (data) => {
  const { flowName } = data;
  
  const confirmResult = await emitPromptAndAwait(pi, {
    pipeline: "flows-manage",
    type: "confirm",
    question: `Delete flow "${flowName}"?`,
  });
  if (confirmResult.cancelled || confirmResult.answer !== "true") {
    pi.events.emit("flow:notify", { message: "Cancelled.", level: "warning" });
    return;
  }
  
  deleteFlowFiles(pi, projectRoot, flowName, matchingFlow.path);
  pi.events.emit("flow:notify", { message: `Flow "${flowName}" deleted.`, level: "info" });
  pi.events.emit("flow:rediscover", {});
});
```

### Pros:
- **Consistent** — same pattern as flow-workspace (proven)
- **Both adapters work** — TUI adapter in flow-tui.ts already handles prompt-request
- **Dashboard can respond** — just needs to listen for prompt-request events
- **Minimal new infrastructure** — reuses existing event protocol

### Cons:
- **Multi-step workflows get verbose** — the `/flows` action menu is a sequence
  of select → select → confirm → action. Each step becomes an emitPromptAndAwait.
- **The TUI adapter in flow-tui.ts needs to handle more prompt types** — currently
  it handles prompt-request for "flow-run" pipeline. Need to add "flows-manage"
  pipeline support.
- **Custom overlays** (`selectOverlay`) can't be replicated this way — they have
  rich TUI rendering (descriptions, icons). Dashboard would get simple selects.

### Effort: **Medium** (2-3 days)

---

## Strategy B: Proxy Pattern (Dashboard UI Proxy Already Exists!)

**Key insight:** The dashboard bridge already has a `ui-proxy.ts` that wraps
`ctx.ui` methods and races TUI vs dashboard responses. When the bridge patches
`ctx.ui` on `session_start`, it replaces `confirm`, `select`, `input`, `notify`
with proxied versions.

### How it works today:

```
bridge.ts session_start           ui-proxy.ts                    
───────────────────────           ───────────                    
                                                                 
// Patch ctx.ui with proxied versions                            
ctx.ui.confirm = uiProxy.wrappedUi.confirm;                     
ctx.ui.select = uiProxy.wrappedUi.select;                       
ctx.ui.input = uiProxy.wrappedUi.input;                         
ctx.ui.notify = uiProxy.wrappedUi.notify;                       
                                                                 
// Now when flow-context calls ctx.ui.select(...)                
//   1. Send extension_ui_request to dashboard                   
//   2. Race with TUI dialog (if hasUI)                          
//   3. First response wins                                      
```

### Does this already work for flow-context commands?

**Partially!** The ui-proxy patches `ctx.ui` at `session_start`. So when
`/flows:delete` calls `ctx.ui.confirm(...)`, it's actually going through the
proxy. The dashboard COULD respond to the confirm dialog.

**But there's a problem:** The proxy races TUI vs dashboard. In a headless
session (no TUI), it only sends to dashboard. This already works for basic
`confirm`, `select`, `input` calls.

**The real problem is `ctx.ui.custom()`** — `selectOverlay` uses `ctx.ui.custom`
for rich TUI rendering (custom components with descriptions, icons, keyboard
handling). This CAN'T be proxied — it's a TUI-specific rendering API.

### What we'd change:

1. **Replace `selectOverlay` calls with plain `ctx.ui.select`** (with
   description info embedded in option labels)
2. **Verify the ui-proxy correctly forwards all flow-context dialogs** 
3. **Dashboard React components handle extension_ui_request for flow commands**

### Pros:
- **Almost zero changes to pi-flows** — the proxy already wraps ctx.ui
- **Dashboard already handles UI requests** — extension_ui_request protocol exists
- **TUI keeps working unchanged** — race means both paths work

### Cons:
- **Loses rich overlays** — `selectOverlay` with descriptions can't be proxied.
  Dashboard can implement its own rich UI, but TUI falls back to plain select.
- **ctx.ui dependency technically remains** — code still calls ctx.ui, just
  the proxy intercepts it. Not a clean architectural boundary.
- **selectOverlay issue** — currently used in `/flows` and `/flows:delete` for
  the action menu with descriptions. Need to replace or provide fallback.

### Effort: **Low** (1-2 days)

---

## Strategy C: Event-Driven Workflows (Full Decoupling)

Transform ALL command handlers into event-driven workflows, similar to how
flow-workspace already works. Each command becomes an event emitter, and
adapters (TUI, dashboard) handle the presentation independently.

### Architecture:

```
                     ┌──────────────────────┐
                     │  Flow CRUD Service    │
                     │  (Pure Logic Layer)   │
                     │                       │
                     │  • listFlows()        │
                     │  • deleteFlow(name)   │
                     │  • getFlowDetails()   │
                     │  • getFlowFiles()     │
                     └──────────┬────────────┘
                                │
                    events       │        events
              ┌─────────────────┼─────────────────┐
              │                 │                   │
              ▼                 ▼                   ▼
    ┌──────────────┐  ┌──────────────┐   ┌──────────────┐
    │  TUI Adapter │  │  Dashboard   │   │   Headless   │
    │              │  │  Adapter     │   │   Adapter    │
    │  ctx.ui.*    │  │  WebSocket   │   │   Auto-pick  │
    │  overlays    │  │  React UI    │   │              │
    └──────────────┘  └──────────────┘   └──────────────┘
```

### Event Protocol for CRUD:

```typescript
// Delete workflow
"flow:delete-request"   → { flowName: string }
"flow:delete-confirm"   → { flowName: string }  // adapter asks user
"flow:delete-confirmed" → { flowName: string, confirmed: boolean }
"flow:delete-result"    → { flowName: string, success: boolean, error?: string }

// List/manage workflow  
"flow:list-request"     → {}
"flow:list-response"    → { flows: FlowInfo[] }

// Action menu workflow
"flow:action-request"   → { flowName: string, actions: Action[] }
"flow:action-selected"  → { flowName: string, action: string }
```

### Pros:
- **Clean architecture** — proper separation of concerns
- **Each adapter gets optimal UX** — dashboard can show React dialogs, TUI shows
  overlays, headless auto-picks
- **Testable** — service layer is pure logic
- **Extensible** — new adapters (VS Code, web, etc.) just listen for events

### Cons:
- **Most work** — requires restructuring flow-context and role-manager
- **Event choreography complexity** — multi-step workflows need careful state
  management across request/response events
- **Might be over-engineering** — the existing emitPromptAndAwait pattern
  already solves most of this

### Effort: **High** (4-6 days)

---

## Strategy D: Hybrid (Recommended)

Combine the best of A and B:

1. **Keep the ui-proxy for simple commands** — `/flows:new` and `/flows:edit`
   already work through events. The few `ctx.ui` calls in `/flows:delete`
   command handler go through the proxy naturally.

2. **Use emitPromptAndAwait for complex workflows** — The `/flows` action menu
   workflow and any multi-step CRUD operations use the prompt event protocol.

3. **Add a thin event API for the dashboard's direct CRUD needs** — The dashboard
   doesn't need to route through slash commands. It can emit events directly:

```typescript
// Dashboard bridge emits these directly (no slash command needed):
pi.events.emit("flow:delete-request", { flowName: "my-flow" });
pi.events.emit("flows:new-request", { description: "..." });
pi.events.emit("flows:edit-request", { flowName: "...", flowPath: "..." });

// These ALREADY EXIST and work! The only missing piece is:
// - flow:delete-request handler needs confirmation (via emitPromptAndAwait)
// - Dashboard needs to handle flow:prompt-request events for confirmation
```

### What Actually Needs to Change:

#### In pi-flows:

**flow-context/index.ts** — Refactor command handlers:
- `/flows:delete` handler → emit `flow:delete-request` (already has event handler!)
  - But the event handler currently skips confirmation. Add it via `emitPromptAndAwait`.
- `/flows` handler → keep ctx.ui for TUI (it's a pi command, always has ctx)
  - Dashboard won't use this command — it has its own React UI
- `/flows:edit` handler → already emits `flows:edit-request` ✅
- `/flows:new` handler → already emits `flows:new-request` ✅

**role-manager.ts** — Lower priority. Dashboard has its own provider/model UI.

#### In pi-agent-dashboard:

**flow-event-wiring.ts** — Add listeners for:
- `flow:prompt-request` events from architect/delete workflows
- Forward as protocol messages to React UI  
- Return `flow:prompt-response` when user responds in dashboard

**React components** — Add:
- Confirmation dialog component for delete operations
- Prompt dialog for architect workflow questions (Save/Replan/Cancel)

### Changes Required (Minimal):

```
pi-flows:
├── flow-context/index.ts       — ~30 lines changed
│   └── /flows:delete handler: emit event instead of direct delete
│   └── flow:delete-request handler: add emitPromptAndAwait confirm
│
├── flow-engine/flow-tui.ts     — ~10 lines added
│   └── Handle "flows-manage" pipeline prompt-requests
│
└── (everything else unchanged)

pi-agent-dashboard:
├── flow-event-wiring.ts        — ~30 lines added
│   └── Forward flow:prompt-request to React UI
│   └── Route React responses back as flow:prompt-response
│
└── React components            — New dialog components
    └── FlowPromptDialog.tsx    — Handle prompt-request events
```

### Effort: **Low-Medium** (2-3 days)

---

## Recommendation

**Go with Strategy D (Hybrid).**

The architecture is 90% there already. The remaining work is:

1. **Make `/flows:delete` event handler ask for confirmation** via
   `emitPromptAndAwait` (the pattern already exists in flow-workspace)

2. **Wire the dashboard to respond to `flow:prompt-request`** events (the TUI
   adapter already does this — dashboard just needs a parallel handler)

3. **Don't touch the TUI command handlers** — they keep working as-is because
   they always have `ctx.ui`. The dashboard uses events directly.

The key realization is that the **dashboard doesn't need to invoke slash
commands**. It can emit events directly:
- `flows:new-request` → flow-workspace handles it ✅
- `flows:edit-request` → flow-workspace handles it ✅  
- `flow:delete-request` → flow-context handles it (needs confirm added)
- `flow:run` → flow-engine handles it ✅
- `flow:list-flows` → flow-engine handles it ✅

The only gap is the confirmation dialog in the delete flow, and the dashboard
being able to respond to `flow:prompt-request` events from the architect
workflows.
