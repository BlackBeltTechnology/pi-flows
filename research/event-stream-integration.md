# Event Stream Integration — pi-flows ↔ pi-agent-dashboard

## Current Event Flow (What Already Works)

```
pi-flows EventEmitObserver          bridge flow-event-wiring.ts       Dashboard React
──────────────────────────          ───────────────────────────       ──────────────

flow:flow-started ──────────────→ event_forward(flow_started) ────→ FlowDashboard.tsx
flow:agent-started ─────────────→ event_forward(flow_agent_started) → FlowAgentCard
flow:agent-complete ────────────→ event_forward(flow_agent_complete) → FlowAgentCard
flow:subagent-tool-call ────────→ event_forward(flow_tool_call) ──→ FlowAgentCard
flow:subagent-tool-result ──────→ event_forward(flow_tool_result) → FlowAgentCard
flow:assistant-text ────────────→ event_forward(flow_assistant_text)→ FlowAgentDetail
flow:thinking-text ─────────────→ event_forward(flow_thinking_text)→ FlowAgentDetail
flow:loop-iteration ────────────→ event_forward(flow_loop_iteration)→ FlowAgentCard
flow:auto-decision ─────────────→ event_forward(flow_auto_decision)→ (unused)
flow:complete ──────────────────→ event_forward(flow_complete) ───→ FlowSummary.tsx
```

This is **fully working**. The dashboard already renders flow execution state.

## Current CRUD Flow (What Partially Works)

```
Dashboard SessionFlowActions        bridge.ts sessionPrompt()         pi-flows
────────────────────────────        ─────────────────────────         ────────

"Run Flow" button                                                     
  └→ onSendPrompt("/custom:x")                                       
      └→ pi.events.emit("flow:run")  ──────────────────→ FlowManager.start()
                                                          ✅ WORKS

"New Flow" button                                                     
  └→ onSendPrompt("/flows:new desc")                                  
      └→ pi.events.emit("flows:new-request") ──────────→ flow-workspace
                                                          ✅ WORKS
         flow:prompt-request ←─────────────────────────── emitPromptAndAwait
         flow:prompt-response ────────────────────────→   continue workflow
                                                          ⚠️ Dashboard can't
                                                             respond yet!

"Delete Flow" (not implemented in dashboard)                          
  └→ pi.events.emit("flow:delete-request") ────────────→ flow-context
                                                          ✅ Deletes immediately
                                                          ❌ No confirmation!
```

## What Needs to Change

### Gap 1: Dashboard Can't Respond to flow:prompt-request

The architect workflow (flows:new, flows:edit) uses `emitPromptAndAwait()` which
emits `flow:prompt-request` events. The TUI adapter in `flow-tui.ts` handles
these and presents TUI dialogs. **But the dashboard doesn't listen for these
events and can't respond.**

#### Current TUI handler (flow-tui.ts):
```typescript
pi.events.on("flow:prompt-request", async (data) => {
  const req = data as { id, type, question, options? };
  let answer;
  if (req.type === "select") answer = await ctx.ui.select(req.question, req.options);
  else if (req.type === "input") answer = await ctx.ui.input(req.question);
  else if (req.type === "confirm") answer = await ctx.ui.confirm(req.question);
  pi.events.emit("flow:prompt-response", { id: req.id, answer, cancelled: !answer });
});
```

**Note:** Since ctx.ui is already proxied by ui-proxy.ts, the TUI prompt
handler's calls to `ctx.ui.select/input/confirm` actually go through the proxy,
which sends `extension_ui_request` to the dashboard AND shows TUI dialog. This
means **the dashboard CAN already respond to architect prompts** — the response
comes back through `extension_ui_response` → ui-proxy → resolves the
`ctx.ui.select()` promise → emits `flow:prompt-response`.

**Wait — this might already work!** Let me trace the full path:

```
flow-workspace                                                        
  └→ emitPromptAndAwait(pi, {type: "select", question: "Save?"})     
      └→ emit("flow:prompt-request", {id, type, question, options})   
                                                                      
flow-tui.ts prompt handler                                            
  └→ listens for "flow:prompt-request"                                
      └→ ctx.ui.select("Save?", ["Save","Replan","Cancel"])           
          │                                                           
          ├─→ ui-proxy intercepts ctx.ui.select()                     
          │     ├→ send extension_ui_request to dashboard  ──→ React UI
          │     └→ show TUI select dialog                             
          │                                                           
          ├─→ Race: first response wins                               
          │     ├─ TUI user picks "Save" → resolves                   
          │     └─ Dashboard user picks "Save" → resolves             
          │                                                           
          └→ emit("flow:prompt-response", {id, answer: "Save"})       
                                                                      
flow-workspace continues                                              
  └→ receives "Save" from the prompt response                         
```

**Conclusion:** The architect workflows (flows:new, flows:edit) might ALREADY
work from the dashboard if the ui-proxy is patched before the TUI prompt
handler fires. This needs verification.

### Gap 2: Delete Confirmation

The `flow:delete-request` event handler in flow-context skips confirmation:

```typescript
// Current: no confirmation, just deletes
pi.events.on("flow:delete-request", (data) => {
  const result = deleteFlowFiles(pi, projectRoot, flowName, matching.path);
  pi.events.emit("flow:delete-result", { ...result, flowName });
});
```

**Fix:** Add confirmation via `emitPromptAndAwait`:

```typescript
pi.events.on("flow:delete-request", async (data) => {
  const { flowName, skipConfirm } = data;
  
  if (!skipConfirm) {
    const confirmResult = await emitPromptAndAwait(pi, {
      pipeline: "flows-manage",
      type: "confirm",
      question: `Delete flow "${flowName}"?`,
    });
    if (confirmResult.cancelled || confirmResult.answer !== "true") {
      pi.events.emit("flow:delete-result", { flowName, success: false, cancelled: true });
      return;
    }
  }
  
  const result = deleteFlowFiles(pi, projectRoot, flowName, matching.path);
  pi.events.emit("flow:delete-result", { ...result, flowName });
});
```

### Gap 3: Dashboard Prompt UI for Architect Workflow

When the architect asks "Save this flow?" or "What would you like to do?", the
dashboard needs to render a dialog. Currently, these come through as
`extension_ui_request` (via ui-proxy wrapping the TUI handler's ctx.ui calls).

The dashboard needs to:
1. Recognize flow-related `extension_ui_request` messages
2. Render appropriate dialog (select, input, confirm)
3. Send `extension_ui_response` back

**This already exists!** The dashboard already handles `extension_ui_request`
for other dialogs. It just needs to handle the ones from flow workflows too.

### Gap 4: Dashboard-Specific Flow Events

The dashboard needs some events that don't exist yet:

```typescript
// Architect lifecycle — dashboard needs to show progress
"flow:architect-started"    → Already emitted ✅ (flow-workspace)
"flow:architect-tool-call"  → Already emitted ✅
"flow:architect-preview"    → Already emitted ✅
"flow:architect-complete"   → Already emitted ✅
"flow:architect-cancelled"  → Already emitted ✅
"flow:architect-saved"      → Already emitted ✅

// These need to be forwarded by flow-event-wiring.ts:
"flow:architect-started"     → architect_started
"flow:architect-tool-call"   → architect_tool_call
"flow:architect-tool-result" → architect_tool_result
"flow:architect-text"        → architect_text
"flow:architect-preview"     → architect_preview
"flow:architect-complete"    → architect_complete
"flow:architect-cancelled"   → architect_cancelled
"flow:architect-saved"       → architect_saved
"flow:architect-error"       → architect_error
"flow:architect-replan"      → architect_replan
```

## Complete Event Protocol

### Events Already Forwarded (flow-event-wiring.ts):
| pi-flows Event | Dashboard Protocol | Direction |
|---|---|---|
| flow:flow-started | flow_started | pi→dashboard |
| flow:agent-started | flow_agent_started | pi→dashboard |
| flow:agent-complete | flow_agent_complete | pi→dashboard |
| flow:subagent-tool-call | flow_tool_call | pi→dashboard |
| flow:subagent-tool-result | flow_tool_result | pi→dashboard |
| flow:assistant-text | flow_assistant_text | pi→dashboard |
| flow:thinking-text | flow_thinking_text | pi→dashboard |
| flow:loop-iteration | flow_loop_iteration | pi→dashboard |
| flow:auto-decision | flow_auto_decision | pi→dashboard |
| flow:complete | flow_complete | pi→dashboard |

### Events To Add to flow-event-wiring.ts:
| pi-flows Event | Dashboard Protocol | Direction |
|---|---|---|
| flow:architect-started | architect_started | pi→dashboard |
| flow:architect-tool-call | architect_tool_call | pi→dashboard |
| flow:architect-tool-result | architect_tool_result | pi→dashboard |
| flow:architect-text | architect_text | pi→dashboard |
| flow:architect-preview | architect_preview | pi→dashboard |
| flow:architect-complete | architect_complete | pi→dashboard |
| flow:architect-cancelled | architect_cancelled | pi→dashboard |
| flow:architect-saved | architect_saved | pi→dashboard |
| flow:architect-error | architect_error | pi→dashboard |
| flow:architect-replan | architect_replan | pi→dashboard |
| flow:delete-result | flow_delete_result | pi→dashboard |

### Dashboard → pi-flows Events (Already Working):
| Dashboard Action | Event | Handler |
|---|---|---|
| Run flow | flow:run | flow-engine/index.ts |
| New flow | flows:new-request | flow-workspace |
| Edit flow | flows:edit-request | flow-workspace |
| Delete flow | flow:delete-request | flow-context |
| List flows | flow:list-flows | flow-engine/index.ts |
| Abort flow | flow:abort | flow-engine/index.ts |
| Toggle auto | flow:toggle-autonomous | flow-engine/index.ts |

### Dashboard ← pi-flows Prompts (Via ui-proxy):
| Prompt Source | Via | Dashboard Handler |
|---|---|---|
| Architect: "Save this flow?" | ctx.ui.select → ui-proxy → extension_ui_request | Dialog component |
| Architect: "Name this flow:" | ctx.ui.input → ui-proxy → extension_ui_request | Input component |
| Architect: "What to change?" | ctx.ui.input → ui-proxy → extension_ui_request | Input component |
| Fork: "Choose branch:" | ctx.ui.select → ui-proxy → extension_ui_request | Dialog component |
| Delete: "Confirm delete?" | emitPromptAndAwait → flow:prompt-request → ctx.ui → ui-proxy | Dialog component |

## Implementation Plan

### Phase 1: Verify Existing Integration (1 day)
1. Test: Does `/flows:new` from dashboard work end-to-end?
   - Dashboard sends prompt → bridge emits `flows:new-request`
   - flow-workspace runs architect → emits `flow:prompt-request`
   - TUI handler calls `ctx.ui.select` → ui-proxy forwards to dashboard
   - Dashboard responds → ui-proxy resolves → prompt-response → architect continues
2. If yes: most of the work is done!
3. If no: identify where the chain breaks

### Phase 2: Forward Architect Events (0.5 day)
1. Add architect lifecycle events to `flow-event-wiring.ts`
2. Add corresponding protocol message types
3. React: show architect progress in dashboard

### Phase 3: Fix Delete Confirmation (0.5 day)
1. Add `emitPromptAndAwait` to `flow:delete-request` handler
2. Dashboard handles the confirm prompt (via ui-proxy chain)
3. Emit `flow:delete-result` for dashboard to update UI

### Phase 4: Dashboard React Components (1-2 days)
1. `ArchitectProgress.tsx` — show architect tool calls, preview
2. `FlowPromptDialog.tsx` — handle extension_ui_request for flow prompts
3. Update `SessionFlowActions.tsx` — add delete button, edit button
4. Update `FlowDashboard.tsx` — integrate architect progress view

### Total Effort: 3-4 days

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ui-proxy doesn't forward flow prompts correctly | Low | High | Test Phase 1 first |
| Race conditions between TUI and dashboard responses | Medium | Medium | ui-proxy already handles this |
| Architect widget state not visible in dashboard | Low | Low | Forward architect events |
| Multiple dashboard sessions responding to same prompt | Low | High | Session ID scoping |
| flow:prompt-request timeout (5 min) too short | Low | Low | Configurable timeout |
