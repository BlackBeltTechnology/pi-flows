# Dashboard Integration Findings — What Already Works

## Critical Discovery: The Integration Is 95% Complete

After deep analysis of both codebases, the pi-flows ↔ pi-agent-dashboard
integration is **much closer to working than initially assumed**. The
architecture is NOT fundamentally broken — there are only a few small gaps.

## The Full Chain (Already Wired)

```
Dashboard React UI
  │
  ├─ SessionFlowActions.tsx
  │    ├─ "Run Flow" → onSendPrompt("/custom:name")
  │    └─ "New Flow" → onSendPrompt("/flows:new desc")
  │
  └─ Interactive Renderers (already exist!)
       ├─ SelectRenderer.tsx    — renders select dialogs
       ├─ ConfirmRenderer.tsx   — renders confirm dialogs
       ├─ InputRenderer.tsx     — renders input dialogs
       ├─ MultiselectRenderer   — renders multiselect
       └─ NotifyRenderer.tsx    — renders notifications
                     │
                     │  extension_ui_response
                     ▼
            bridge.ts WebSocket
                     │
                     │  extension_ui_request
                     ▼
            ui-proxy.ts
              │
              ├─ Wraps ctx.ui.select/confirm/input/notify
              ├─ Races TUI vs dashboard response
              └─ First response wins
                     │
                     │  ctx.ui.select("Save?", [...])
                     ▼
            flow-tui.ts prompt handler
              │
              └─ Listens flow:prompt-request
                 Calls ctx.ui.select (proxied!)
                 Emits flow:prompt-response
                     │
                     ▼
            flow-workspace / flow-engine
              │
              └─ emitPromptAndAwait resolves
                 Workflow continues
```

**The ui-proxy patches ctx.ui at session_start.** After that, ANY code that
calls `ctx.ui.select()`, `ctx.ui.confirm()`, etc. is automatically forwarded
to the dashboard AND races with TUI. This means:

1. **Architect Save/Replan/Cancel dialog** — works via prompt-request → flow-tui
   → ctx.ui.select (proxied) → dashboard SelectRenderer ✅
2. **Fork decision prompts during flow run** — works via FlowIOAdapter.askUser
   → ctx.ui.select (proxied) → dashboard SelectRenderer ✅  
3. **Extension UI ask_user requests** — works via AskUserQueue → ctx.ui.select
   (proxied) → dashboard SelectRenderer ✅

## What's Actually Missing

### 1. Dashboard Can't Trigger Delete with Confirmation

The `flow:delete-request` event handler in flow-context deletes immediately
without confirmation. The `/flows:delete` command handler asks for confirmation
via `ctx.ui.confirm()`, but that's only available from the TUI command context.

**Fix:** Add `emitPromptAndAwait` confirmation to the event handler. ~15 lines.

### 2. Architect Lifecycle Events Not Forwarded to Dashboard

The flow-event-wiring.ts only forwards flow execution events (flow_started,
flow_agent_started, etc.). It doesn't forward architect events:

```
flow:architect-started    — Not forwarded
flow:architect-tool-call  — Not forwarded
flow:architect-preview    — Not forwarded
flow:architect-complete   — Not forwarded
flow:architect-saved      — Not forwarded
```

**Fix:** Add these to the FLOW_EVENT_MAP in flow-event-wiring.ts. ~15 lines.

### 3. Dashboard Has No Architect Progress UI

When the architect is designing a flow, the TUI shows an architect widget with
tool calls, preview, etc. The dashboard has no equivalent.

**Fix:** New React component `ArchitectProgress.tsx`. Medium effort.

### 4. Dashboard Flows UI Needs Edit/Delete Buttons

`SessionFlowActions.tsx` has "Run Flow" and "New Flow" buttons but no
"Edit Flow" or "Delete Flow" buttons.

**Fix:** Add buttons that emit the right events. Small effort.

### 5. Re-fetch Flows List After Architect Saves

After the architect saves a flow, the dashboard needs to refresh its flows list.
The `flow:architect-saved` event should trigger a re-fetch.

**Fix:** Already partially handled — `flow:rediscover` and `flow:complete`
trigger `resendCommandsAndFlows`. Need to also trigger on `flow:architect-saved`.

## What Does NOT Need to Change

| Component | Status | Why |
|-----------|--------|-----|
| FlowManager | ✅ No changes | Already adapter-based |
| flow-execution.ts | ✅ No changes | Callback-driven |
| flow-workspace/index.ts | ✅ No changes | Uses emitPromptAndAwait |
| flow-prompt.ts | ✅ No changes | Event protocol works |
| flow-tui.ts prompt handler | ✅ No changes | ctx.ui calls go through proxy |
| flow-io-tui.ts | ✅ No changes | ctx.ui calls go through proxy |
| ui-proxy.ts | ✅ No changes | Already handles race |
| EventEmitObserver | ✅ No changes | Already emits all events |
| FlowDashboard.tsx | ✅ No changes | Already renders flow state |
| flow-reducer.ts | ✅ No changes | Already handles flow events |
| Interactive renderers | ✅ No changes | Already handle all dialog types |

## Minimal Change List

### pi-flows changes:
1. **flow-context/index.ts** — Add `emitPromptAndAwait` confirmation to
   `flow:delete-request` event handler (15 lines)

### pi-agent-dashboard changes:
1. **flow-event-wiring.ts** — Add architect lifecycle events to forwarding map
   (15 lines)
2. **flow-event-wiring.ts** — Trigger flows refresh on `flow:architect-saved`
   (5 lines)  
3. **SessionFlowActions.tsx** — Add Edit/Delete buttons (30 lines)
4. **ArchitectProgress.tsx** — New component for architect progress (100 lines)
5. **flow-reducer.ts** — Add architect event handling (50 lines)

### Total: ~215 lines of changes across both repos

## Verification Steps

Before implementing, verify these assumptions:

1. **Test `/flows:new` from dashboard end-to-end** — Does the architect
   Save/Replan/Cancel dialog appear as an interactive UI card in the chat?
2. **Test flow run with fork** — Does the fork decision dialog appear in dashboard?
3. **Test `/flows:edit` from dashboard** — Does the edit workflow work?

If these work, the integration effort is truly minimal.

## Architecture Diagram — After Changes

```
┌─────────────────────────────────────────────────────────────────┐
│                        pi-flows                                  │
│                                                                  │
│  ┌────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ flow-engine │  │  flow-      │  │ flow-context │              │
│  │ FlowManager │  │  workspace  │  │ CRUD events  │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                 │                     │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐             │
│  │ FlowObserver│  │ emitPrompt  │  │ emitPrompt  │  ← NEW      │
│  │ (events)    │  │ AndAwait    │  │ AndAwait    │  (for delete)│
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │                │                 │                     │
│         └────────────────┴─────────────────┘                     │
│                          │                                       │
│               pi.events (flow:*, flow:prompt-*)                  │
│                          │                                       │
│  ┌───────────────────────┴───────────────────────┐              │
│  │              flow-tui.ts                       │              │
│  │  Handles flow:prompt-request via ctx.ui.*      │              │
│  │  (ctx.ui is proxied by ui-proxy!)              │              │
│  └────────────────────────────────────────────────┘              │
└──────────────────────────┬───────────────────────────────────────┘
                           │
            pi.events + ctx.ui (proxied)
                           │
┌──────────────────────────┴───────────────────────────────────────┐
│                    pi-agent-dashboard                              │
│                                                                   │
│  ┌─────────────┐    ┌────────────────────────────────────┐       │
│  │  bridge.ts   │←──│  ui-proxy.ts                        │       │
│  │  WebSocket   │    │  Patches ctx.ui at session_start   │       │
│  └──────┬───────┘    │  Races TUI ↔ Dashboard responses   │       │
│         │            └────────────────────────────────────┘       │
│         │                                                         │
│  ┌──────┴───────┐    ┌────────────────────────────────────┐       │
│  │  flow-event  │    │  React Components                   │       │
│  │  -wiring.ts  │    │                                     │       │
│  │  ┌──────────┐│    │  FlowDashboard      (existing ✅)  │       │
│  │  │+ architect││    │  FlowAgentCard      (existing ✅)  │       │
│  │  │  events   ││    │  FlowSummary        (existing ✅)  │       │
│  │  │  NEW      ││    │  SessionFlowActions (+ edit/del)   │       │
│  │  └──────────┘│    │  ArchitectProgress   (NEW)         │       │
│  └──────────────┘    │  SelectRenderer      (existing ✅)  │       │
│                       │  ConfirmRenderer     (existing ✅)  │       │
│                       │  InputRenderer       (existing ✅)  │       │
│                       └────────────────────────────────────┘       │
└───────────────────────────────────────────────────────────────────┘
```

## Summary

The "TUI coupling problem" is much smaller than it appeared. The critical
architecture decisions were already made:

1. **FlowManager with adapter pattern** — done
2. **emitPromptAndAwait for workflows** — done (flow-workspace)
3. **ui-proxy that bridges ctx.ui to dashboard** — done
4. **Interactive renderers for all dialog types** — done
5. **Event forwarding infrastructure** — done

The remaining work is:
- Wire a few missing events
- Add confirmation to one event handler
- Build one new React component (architect progress)
- Add two buttons to an existing component
