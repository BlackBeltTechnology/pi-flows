# TUI Coupling Analysis — pi-flows

## Problem Statement

pi-flows currently works perfectly in the pi TUI. We want to integrate it into
pi-agent-dashboard as a React UI component that can also create, delete, and
edit flows. The dashboard uses a bridge extension that forwards events over
WebSocket. **The core problem: pi-flows commands and workflows have direct TUI
dependencies that prevent them from working through an event-only interface.**

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          pi-flows                                   │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐            │
│  │ flow-engine  │  │flow-workspace│  │ flow-context   │            │
│  │  (index.ts)  │  │  (index.ts)  │  │  (index.ts)   │            │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘            │
│         │                  │                   │                    │
│  ┌──────┴───────┐         │          ┌────────┴────────┐          │
│  │ FlowManager  │         │          │  /flows          │          │
│  │ (decoupled!) │         │          │  /flows:new      │          │
│  └──────────────┘         │          │  /flows:edit     │          │
│                           │          │  /flows:delete   │          │
│  ┌──────────────┐         │          └─────────────────┘          │
│  │  flow-tui.ts │         │                   │                    │
│  │ (TUI only)   │         │                   │                    │
│  └──────────────┘         │                   │                    │
│                           │                   │                    │
│  ┌──────────────┐         │                   │                    │
│  │ flow-io-tui  │         │                   │                    │
│  │ (TUI only)   │         │                   │                    │
│  └──────────────┘         │                   │                    │
│                                                                     │
│  ┌────────────────────────────────────┐                            │
│  │       role-manager.ts              │                            │
│  └────────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
         │                  │                   │
         │ events           │ events            │ ctx.ui (PROBLEM!)
         ▼                  ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    pi-agent-dashboard                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐    │
│  │  bridge.ts   │  │  flow-event  │  │  React Components     │    │
│  │              │  │  -wiring.ts  │  │  FlowDashboard.tsx    │    │
│  └──────────────┘  └──────────────┘  │  SessionFlowActions   │    │
│                                       │  FlowLaunchDialog     │    │
│                                       └───────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## What's Already Decoupled (✅)

### 1. FlowManager (flow-manager.ts) — CLEAN
- Pure orchestration, zero TUI imports
- Takes `FlowIOAdapter` for user interaction
- Takes `FlowObserver[]` for lifecycle events
- Already swappable: headless adapter is default, TUI adapter set on `session_start`

### 2. Flow Execution (flow-execution.ts, execution.ts) — CLEAN
- Pure computation, callback-driven
- All user interaction via callbacks: `askUser`, `onAgentStarted`, `onToolCall`, etc.

### 3. flow-workspace (flow-workspace/index.ts) — CLEAN
- Uses `emitPromptAndAwait()` for ALL user interaction (no ctx.ui!)
- Emits lifecycle events: `flow:architect-started`, `flow:architect-preview`, etc.
- TUI adapter in flow-tui.ts handles the events and renders widgets

### 4. EventEmitObserver (flow-tui.ts) — CLEAN
- Emits all flow lifecycle as pi.events
- Dashboard already receives these via flow-event-wiring.ts

### 5. flow:prompt-request/response (flow-prompt.ts) — CLEAN
- Event-based prompt infrastructure
- First adapter to respond wins
- Dashboard could respond to these!

## What's Still Coupled to TUI (❌)

### 1. flow-context/index.ts — HEAVILY COUPLED
**This is the #1 problem.** The `/flows`, `/flows:new`, `/flows:edit`, `/flows:delete` 
command handlers use `ctx.ui` directly:

```
/flows command handler:
  ├── ctx.ui.select("Flows", options)          ← TUI select
  ├── ctx.ui.input("Describe what...")          ← TUI input  
  ├── ctx.ui.notify(...)                        ← TUI notify
  ├── ctx.ui.confirm("Delete flow?")            ← TUI confirm
  └── selectOverlay(ctx, ...)                   ← TUI custom overlay

/flows:delete command handler:
  ├── selectOverlay(ctx, ...)                   ← TUI custom overlay
  ├── ctx.ui.confirm("Delete flow?")            ← TUI confirm
  └── ctx.ui.notify(...)                        ← TUI notify

/flows:edit command handler:
  ├── ctx.ui.select("Select flow to edit:")     ← TUI select
  └── ctx.ui.notify(...)                        ← TUI notify

/flows:new command handler:
  ├── ctx.ui.input("Describe what...")          ← TUI input
  └── ctx.ui.notify(...)                        ← TUI notify
```

**Why this matters:** When the dashboard sends `/flows:new` via `sessionPrompt`,
it goes through `pi.events.emit("flows:new-request", ...)` which routes to
flow-workspace (decoupled ✅). But `/flows:delete` and the main `/flows` command
still need `ctx.ui` — they can't work through the dashboard bridge.

### 2. role-manager.ts — MODERATELY COUPLED
The `/roles` and `/provider` commands use `ctx.ui` directly:
```
/roles handler:
  ├── ctx.ui.select("Model Roles", options)
  ├── ctx.ui.input("Preset name", "default")
  ├── ctx.ui.select("Select role to edit", ...)
  └── ctx.ui.notify(...)
```

### 3. flow-tui.ts — BY DESIGN (TUI rendering layer)
This IS the TUI adapter — it's supposed to be TUI-specific. But it also
contains the `TuiFlowObserver` which handles lifecycle transitions (dashboard
mount/unmount, summary widget management). These should stay TUI-only.

### 4. shared/overlays.ts — TUI ONLY
`selectOverlay()` and friends use `ctx.ui.custom()` for rich TUI overlays.
These can't work in the dashboard at all.

## Current Dashboard Integration Path

```
Dashboard React UI                pi-agent-dashboard              pi-flows
─────────────────                 ──────────────────              ────────
                                                                 
User clicks "Run Flow"                                           
  │                                                              
  ├─→ onSendPrompt("/custom:my-flow")                           
  │     │                                                        
  │     └─→ bridge.ts sessionPrompt()                            
  │           │                                                  
  │           └─→ pi.events.emit("flow:run", ...)  ───────→ FlowManager.start()
  │                                                    ✅ Works!
  │                                                              
User clicks "New Flow"                                           
  │                                                              
  ├─→ onSendPrompt("/flows:new description")                     
  │     │                                                        
  │     └─→ bridge.ts sessionPrompt()                            
  │           │                                                  
  │           └─→ pi.events.emit("flows:new-request")  ──→ flow-workspace
  │                                                    ✅ Works!
  │               (uses emitPromptAndAwait,                      
  │                dashboard can respond via                      
  │                flow:prompt-request/response)                  
  │                                                              
User clicks "Delete Flow" (from dashboard)                       
  │                                                              
  ├─→ onSendPrompt("/flows:delete my-flow")                      
  │     │                                                        
  │     └─→ bridge.ts sessionPrompt()                            
  │           │                                                  
  │           ├─→ pi.events.emit("flow:delete-request")          
  │           │     └─→ flow-context event handler  ──→ deleteFlowFiles()
  │           │                                        ✅ Works! (simple event)
  │           │                                                  
  │           └─→ But what about the confirmation dialog?         
  │                The event handler just deletes immediately.    
  │                The command handler asks ctx.ui.confirm first.  
  │                                                    ❌ No confirm from dashboard!
  │                                                              
User clicks "Manage Flows" (from dashboard)                      
  │                                                              
  └─→ The /flows command with action menu?                       
        This requires ctx.ui.select, ctx.ui.input, selectOverlay 
                                                     ❌ Can't work!
```

## The Key Insight

The architecture is **mostly decoupled** already:

1. **Flow execution** — fully decoupled via FlowManager + adapters
2. **Flow creation** (flows:new) — fully decoupled via events
3. **Flow editing** (flows:edit) — fully decoupled via events  
4. **Flow running** — fully decoupled via events

The remaining coupling is in the **CRUD command handlers** in `flow-context/index.ts`
and `role-manager.ts` — these use `ctx.ui` for confirmation dialogs, selection
menus, and notifications.

## Impact Assessment

| Component | Files | TUI Calls | Decoupling Effort |
|-----------|-------|-----------|-------------------|
| flow-context (`/flows`, `/flows:delete`, `/flows:edit`, `/flows:new`) | 1 file | ~20 ctx.ui calls | Medium |
| role-manager (`/roles`, `/provider`) | 1 file | ~8 ctx.ui calls | Medium |
| shared/overlays (`selectOverlay`) | 1 file | 4 ctx.ui.custom calls | Low (used by flow-context) |
| flow-tui (TUI adapter) | 1 file | Many (by design) | N/A — stays TUI |
| flow-io-tui (TUI adapter) | 1 file | Many (by design) | N/A — stays TUI |
| flow-engine/index (session_start wiring) | 1 file | 3 ctx.ui calls | Low |
| flow-footer | 1 file | 0 (pure render) | None |
