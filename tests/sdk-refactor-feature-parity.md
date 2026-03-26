# SDK Subagent Refactor — Feature Parity Test Plan

> Run this test plan after the SDK refactor is complete.
> Each test verifies a specific feature from `features.md` still works.
> Mark each checkbox when verified. All must pass before merging.

## Prerequisites

1. Working pi-judo project with all flows registered
2. At least one provider configured (`/provider`)
3. Roles assigned (`/roles`) — at minimum `@planning`, `@coding`, `@compact`, `@fast`
4. A change exists in `openspec/changes/` for plan flow testing

---

## Test 1: Basic Agent Step Execution (§1.4, §2.1, §2.2, §2.7, §2.8)

**Flow:** `judo:archive` (simplest — 2 sequential agent steps)

```
Run: /judo:archive
```

- [ ] **1.1** Flow starts without errors
- [ ] **1.2** `judo-archiver` agent card appears in dashboard with spinning indicator
- [ ] **1.3** Tool calls appear on the card (read, write, grep visible in last-3 tool area)
- [ ] **1.4** Token counts update on the card during execution (input/output numbers > 0)
- [ ] **1.5** Agent completes — card shows ✓ or ✗ status icon
- [ ] **1.6** Duration shown on completed card
- [ ] **1.7** `judo-git-manager` starts AFTER `judo-archiver` completes (blockedBy respected)
- [ ] **1.8** Flow summary appears after completion with insights

**What this validates:** In-process session creation, prompt() awaiting, tool callbacks, token accumulation, assistant text capture, sequential execution, finish tool enforcement.

---

## Test 2: Parallel DAG Execution with Input Wiring (§1.4, §1.5, §1.6)

**Flow:** `judo:research` (parallel agents with blockedBy and inputs)

```
Run: /judo:research
```

- [ ] **2.1** Fork "Which domains should be researched?" appears with checkbox overlay (multiSelect)
- [ ] **2.2** Select all three: model, backend, frontend → all three branches activate
- [ ] **2.3** `judo-model-researcher` starts first (no dependencies)
- [ ] **2.4** `judo-backend-researcher` and `judo-frontend-researcher` start AFTER model completes (blockedBy)
- [ ] **2.5** Backend and frontend run IN PARALLEL (both cards show spinning simultaneously)
- [ ] **2.6** `judo-summarizer` starts after ALL three complete
- [ ] **2.7** Summarizer receives inputs: check that it accesses model/backend/frontend research results (visible in detail view tool calls — it should read the research files)
- [ ] **2.8** All cards show final status after flow completes
- [ ] **2.9** Summary widget shows all agent results

**What this validates:** Parallel wave execution, blockedBy dependencies, multiSelect fork, input wiring (`{result.STEP.summary}`), Promise.all behavior with SDK sessions.

---

## Test 3: Fork with Notes + Autowiring (§9.1, §9.3, §1.5)

**Flow:** `judo:plan`

```
Run: /judo:plan "Add a new user profile feature"
```

- [ ] **3.1** `task_required` prompt does NOT appear (task provided as arg)
- [ ] **3.2** Conditional `has-proposal` evaluates correctly (checks for prior artifacts)
- [ ] **3.3** Fork "Review design decisions interactively..." appears with 2 options
- [ ] **3.4** Branch targets shown inline: e.g., "Yes, discuss design first → design-discuss"
- [ ] **3.5** Select "Yes, discuss design first"
- [ ] **3.6** `design-discuss` agent starts and the fork answer is autowired (check detail view — should see "## User Decision" in context)
- [ ] **3.7** After design-discuss completes, `create-proposal` starts
- [ ] **3.8** `resolve-gaps` fork appears with `allowNotes: true`
- [ ] **3.9** Select "Resolve gaps now" → notes prompt appears → enter some notes
- [ ] **3.10** `gap-filler` agent starts and receives the fork notes in context (check detail view)

**What this validates:** Fork UI, allowNotes, fork context autowiring, conditional steps, template variable expansion, task_required/task_prompt.

---

## Test 4: Agent Loop Decision (§9.5, §2.5)

**Flow:** `judo:plan` (continued from Test 3, or `judo:apply`)

- [ ] **4.1** `agent-loop-decision: gap-check` fires after gap-filler
- [ ] **4.2** Decision agent dispatches with `branch` parameter (loop/exit)
- [ ] **4.3** If agent chooses "loop" → execution returns to `resolve-gaps` fork
- [ ] **4.4** Loop iteration counter displayed on card (if applicable)
- [ ] **4.5** Max iterations (2) enforced — loop force-exits after 2 iterations even if agent keeps choosing "loop"

**What this validates:** Agent loop decision, finish tool branch parameter, loop counter tracking, max_iterations enforcement.

---

## Test 5: Agent Decision Step (§9.4)

**Flow:** `judo:apply` (has `agent-decision` and `agent-loop-decision`)

```
Run: /judo:apply "Implement the user profile feature"
```

- [ ] **5.1** `judo-flow-writer` creates an execution flow via `flow_write`
- [ ] **5.2** `flow-ref: apply-execution` picks up the generated flow
- [ ] **5.3** `judo-verifier` runs and produces verification result
- [ ] **5.4** `agent-loop-decision: verify-loop` dispatches decision agent
- [ ] **5.5** Decision routes correctly: "loop" → backpropagator, "exit" → summarizer
- [ ] **5.6** If looped: `judo-backpropagator` runs, fix flow generated, verify-loop re-evaluated

**What this validates:** Agent decision steps, flow-ref with glob, decision branch routing, loop decisions in apply context.

---

## Test 6: Abort Mid-Flow (§20.2, §15.1)

**Flow:** Any (use `judo:research` for parallel agents)

```
Run: /judo:research
Select all domains at fork
While agents are running, press Ctrl+X
```

- [ ] **6.1** Abort signal fires
- [ ] **6.2** All running agent sessions abort (cards stop spinning promptly — within 2-3 seconds)
- [ ] **6.3** Cards show abort/error state
- [ ] **6.4** Flow result is "cancelled" / error state
- [ ] **6.5** No orphaned sessions or hanging promises
- [ ] **6.6** Main session returns to responsive state (can type commands)

**What this validates:** `session.abort()` works, AbortSignal wiring, no process cleanup needed, FlowCancelledError handling.

---

## Test 7: Dashboard Navigation & Detail View (§4.1–§4.4, §5.1)

**During any flow execution:**

- [ ] **7.1** Cards render in responsive grid (resize terminal to verify column adjustment)
- [ ] **7.2** Press Ctrl+O → navigate mode activates (card highlights)
- [ ] **7.3** Arrow keys navigate between cards in grid
- [ ] **7.4** Press Enter on a card → detail overlay opens
- [ ] **7.5** Detail view shows: thinking blocks (if model supports), assistant text, tool calls with input/output
- [ ] **7.6** ↑↓ navigates entries, Enter expands/collapses tool call details
- [ ] **7.7** Ctrl+T toggles thinking block visibility
- [ ] **7.8** ESC closes detail overlay → back to navigate mode
- [ ] **7.9** ESC again → back to passive mode

**What this validates:** Dashboard rendering, input routing, detail view data (from subscribe events), navigation state machine.

---

## Test 8: Flow Summary (§6.1–§6.4)

**After any flow completes:**

- [ ] **8.1** Summary spinner shows while LLM generates insights
- [ ] **8.2** Summary widget appears with boxed border
- [ ] **8.3** Shows: flow name, agent count, total duration, insight bullets
- [ ] **8.4** Ctrl+O in summary → navigate mode (agent list with metrics)
- [ ] **8.5** Enter on agent → detail overlay with full history
- [ ] **8.6** Ctrl+X dismisses summary
- [ ] **8.7** Result files persisted: check `.pi/flows/results/<flow>.md` and `.pi/flows/results/<flow>.json` exist
- [ ] **8.8** `flow_results` tool works: run from main session, verify `list`, `summary`, `agent` actions return data

**What this validates:** Summary generation, result persistence, summary navigation, flow_results tool.

---

## Test 9: Architect — New Flow (§8.1, §8.6, §8.7, §8.8)

```
Run: /flows:new
Describe a simple flow when prompted
```

- [ ] **9.1** Conversation context extracted, slug generated
- [ ] **9.2** Architect widget appears above editor (design mode)
- [ ] **9.3** Widget shows: agent list (built-in/custom), DAG tree, tool call status
- [ ] **9.4** Architect calls `agent_catalog`, `agent_validate`, `agent_write`, `flow_validate`, `flow_write`, `flow_preview` — tracked in widget
- [ ] **9.5** After design: choice overlay (Run / Save & Run / Replan / Cancel)
- [ ] **9.6** Press Ctrl+O during design → flow preview overlay opens (scrollable)
- [ ] **9.7** Choose "Replan" → replan notes prompt → architect re-runs with notes
- [ ] **9.8** Choose "Cancel" → architect aborted cleanly, widget removed
- [ ] **9.9** Choose "Save & Run" → flow saved to `.pi/flows/flows/custom/`, registered as command, flow executes

**What this validates:** Architect spawn via SDK session, tool call tracking callbacks, Ctrl+X/Ctrl+O during design, replan loop, abort, file persistence.

---

## Test 10: Architect — Edit Flow (§8.2)

```
Run: /flows:edit
Select an existing flow
Enter modification request
```

- [ ] **10.1** Existing flow content loaded
- [ ] **10.2** Architect edits the flow
- [ ] **10.3** Preview shows modified flow
- [ ] **10.4** Choice: Save / Replan / Cancel
- [ ] **10.5** "Save" copies back to original location

**What this validates:** Edit architect spawn, content loading, save-back logic.

---

## Test 11: Subagent Tool (§7.9)

**From main session (not in a flow):**

```
Ask the LLM: "Use the subagent tool to dispatch project-context-reader 
to read the project structure"
```

- [ ] **11.1** Subagent tool call appears in main session
- [ ] **11.2** Subagent executes (project-context-reader runs)
- [ ] **11.3** Result returned to main session LLM
- [ ] **11.4** No errors, no hanging

**For parallel:**
```
Ask: "Use the subagent tool in parallel mode to dispatch 
project-context-reader and flow-architect simultaneously"
```

- [ ] **11.5** Both agents run in parallel
- [ ] **11.6** Results concatenated and returned

**What this validates:** Ad-hoc subagent spawning via tool, single and parallel modes.

---

## Test 12: Guard — Tool Whitelist (§2.3)

**Implicit in all agent executions:**

- [ ] **12.1** During any flow, check agent detail view — only declared tools should be called
- [ ] **12.2** If an agent tries to call an undeclared tool, it should be blocked (visible in tool call history as blocked/error)

**What this validates:** Guard extension tool whitelist enforcement via factory (not env var).

---

## Test 13: Guard — Access Control (§2.4)

**Using an agent with `access:` restrictions (e.g., judo-proposal-writer):**

- [ ] **13.1** Agent can read files within allowed paths (`application/**`, `judospec/**`)
- [ ] **13.2** Agent cannot read files outside allowed paths (would show blocked in detail view)
- [ ] **13.3** Agent cannot write outside allowed paths

**What this validates:** Access rules passed as direct parameter (not temp file), glob matching still works.

---

## Test 14: Guard — Finish Tool Enforcement (§2.2)

**Implicit in all agent executions:**

- [ ] **14.1** Every agent calls `finish` tool as its last action (visible in tool call history)
- [ ] **14.2** Result has structured data (status, summary, files)
- [ ] **14.3** If an agent doesn't call finish (rare), retry message sent and agent retries

**What this validates:** Finish tool registered via factory, tool_call blocking after finish, agent_end retry via sendUserMessage.

---

## Test 15: Autonomous Mode (§9.2)

```
During a flow with forks:
Press Ctrl+A to toggle autonomous mode
```

- [ ] **15.1** Footer shows "🤖 auto" indicator after Ctrl+A
- [ ] **15.2** Next fork with `agent:` field auto-decides without showing UI
- [ ] **15.3** `flow:auto-decision` event emitted
- [ ] **15.4** Ctrl+A again → autonomous mode off, forks show UI again
- [ ] **15.5** At any fork prompt, "🤖 Auto-decide (let AI choose)" option visible (for forks with agent field)
- [ ] **15.6** Selecting auto-decide: agent dispatches, decides branch, flow continues

**What this validates:** Autonomous mode toggle, persisted setting, auto-decide option, agent decision dispatch.

---

## Test 16: Token & File Tracking (§2.7, §12.1)

**After any flow:**

- [ ] **16.1** Dashboard cards show non-zero token counts (input/output)
- [ ] **16.2** Summary includes token totals
- [ ] **16.3** Footer shows file stats (+insertions/-deletions) if agents modified files
- [ ] **16.4** `flow:subagent-tool-result` events emit for write/edit tool calls

**What this validates:** Token accumulation from message_end events, file tracker integration.

---

## Test 17: Provider & Roles (§10.1–§10.4)

- [ ] **17.1** `/provider` command works — can list/add/edit providers
- [ ] **17.2** `/roles` command works — can assign models to roles
- [ ] **17.3** Footer shows current provider and model
- [ ] **17.4** Agent cards show correct model role (e.g., "@planning", "@coding")

**What this validates:** Provider system unaffected by refactor (not directly involved but must still work).

---

## Test 18: Flow Discovery & Commands (§3.1–§3.4)

- [ ] **18.1** `/judo:plan`, `/judo:research`, `/judo:apply`, `/judo:archive` all registered as commands
- [ ] **18.2** `/flows` menu shows all flows with actions
- [ ] **18.3** Agent catalog includes pi-judo agents (judo-proposal-writer, etc.)
- [ ] **18.4** `agent_catalog` tool returns correct data

**What this validates:** Discovery, registration, package events all work (not directly changed but depend on the extension system).

---

## Test 19: task_required and task_prompt (§20.1)

```
Run: /judo:plan (without arguments)
```

- [ ] **19.1** User is prompted: "Describe what you want to build or change:"
- [ ] **19.2** Enter a description → flow starts with that task
- [ ] **19.3** `{task}` template variable expanded in agent tasks

```
Run: /judo:plan "Direct task argument"
```

- [ ] **19.4** No prompt shown — task argument used directly

**What this validates:** task_required/task_prompt flow config, template variable expansion.

---

## Test 20: Conditional Steps (§1.3)

**Flow:** `judo:plan` (has multiple conditional steps)

- [ ] **20.1** `conditional: has-proposal` evaluates based on artifacts presence
- [ ] **20.2** If artifacts present → routes to `revise-intent`
- [ ] **20.3** If artifacts absent → routes to `design-questions`
- [ ] **20.4** Other conditionals (`after-discuss`, `after-create`, etc.) route correctly

**What this validates:** Conditional step evaluation, field presence checking, branch routing.

---

## Test 21: Flow Gate Blocking (§16.1)

- [ ] **21.1** If pi-judo registers a gate (e.g., model file validation), it blocks flow execution when conditions aren't met
- [ ] **21.2** Gate message displayed to user
- [ ] **21.3** Flow does not start if gate blocks

**What this validates:** Gate registration and checking (not directly changed but exercises the event system).

---

## Test 22: Breadcrumb & Workflow (§4.5, §4.6)

**If pi-judo registers a workflow with multiple stages:**

- [ ] **22.1** Breadcrumb shows workflow stages: e.g., `✓ research → [plan] → apply`
- [ ] **22.2** Current stage highlighted
- [ ] **22.3** Completed stages show ✓

**What this validates:** Workflow registry, breadcrumb rendering (not directly changed).

---

## Summary Checklist

| Area | Tests | Status |
|------|-------|--------|
| Basic execution | 1.1–1.8 | ☐ |
| Parallel DAG | 2.1–2.9 | ☐ |
| Fork + autowiring | 3.1–3.10 | ☐ |
| Loop decisions | 4.1–4.5 | ☐ |
| Agent decisions | 5.1–5.6 | ☐ |
| Abort | 6.1–6.6 | ☐ |
| Dashboard & detail | 7.1–7.9 | ☐ |
| Summary | 8.1–8.8 | ☐ |
| Architect new | 9.1–9.9 | ☐ |
| Architect edit | 10.1–10.5 | ☐ |
| Subagent tool | 11.1–11.6 | ☐ |
| Guard whitelist | 12.1–12.2 | ☐ |
| Guard access | 13.1–13.3 | ☐ |
| Guard finish | 14.1–14.3 | ☐ |
| Autonomous mode | 15.1–15.6 | ☐ |
| Token & file tracking | 16.1–16.4 | ☐ |
| Provider & roles | 17.1–17.4 | ☐ |
| Discovery & commands | 18.1–18.4 | ☐ |
| Task required | 19.1–19.4 | ☐ |
| Conditional steps | 20.1–20.4 | ☐ |
| Gate blocking | 21.1–21.3 | ☐ |
| Breadcrumb | 22.1–22.3 | ☐ |

**Total: 22 test areas, 107 individual checks**

All 107 checks must pass for the SDK refactor to be considered feature-complete.
