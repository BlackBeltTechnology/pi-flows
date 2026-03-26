# pi-flows — Complete Feature Reference

> Auto-generated feature catalog with source file references.
> Based on latest commit state of the `pi-flows` package.

---

## 1. Flow Engine Core

### 1.1 Flow Parsing (.flow.md format)
Parses `.flow.md` files with YAML frontmatter and `##`-delimited step sections. Custom minimal YAML parser (no library dependency). Supports multiline scalars (`>` folded, `|` literal).

- **File**: `extensions/flow-engine/flow-parser.ts`
  - `parseFlowFile()` — line 18
  - `parseFlowString()` — line 25
  - `splitFrontmatter()` — line 72
  - `parseFrontmatter()` — line 95 (minimal YAML subset parser)
  - `parseSteps()` — line 147 (splits body by `##` headers)
  - `parseProperties()` — line 193 (handles nested blocks, multiline `>` and `|`)
  - `validateSegmentBlockedBy()` — line 354 (cross-segment blockedBy rejection)

### 1.2 Agent Parsing (.md format)
Parses agent `.md` files with YAML frontmatter (name, description, model, tools, skills, context, inputs, access, card, architect) and system prompt body.

- **File**: `extensions/flow-engine/agent-parser.ts`
  - `parseAgentFile()` — line 11
  - `parseAgentString()` — line 18
  - `parseFrontmatterFields()` — line 107 (flat map with dotted nested keys: `access.read`, `card.label`, `architect.use_when`)
  - `parseAccessBlock()` — line 180 (read/write glob patterns, bash deny list)

### 1.3 Flow Step Types (Discriminated Union)
Six step types supported:

| Step Type | Header Prefix | Description |
|-----------|---------------|-------------|
| **AgentStep** | `## step-id` | Dispatches a named agent with task, inputs, blockedBy |
| **ForkStep** | `## fork: id` | User choice with branches, allowNotes, allowCustom, multiSelect, autonomous agent |
| **ConditionalStep** | `## conditional: id` | Branch on data presence (check/present/absent) |
| **AgentDecisionStep** | `## agent-decision: id` | Agent-driven routing via `finish({branch})` |
| **AgentLoopDecisionStep** | `## agent-loop-decision: id` | Iterative loops with loop_target/exit_target/max_iterations |
| **FlowRefStep** | `## flow-ref: path` | Delegates to sub-flow file(s), supports glob patterns |

- **File**: `extensions/flow-engine/types.ts` — lines 56–117 (type definitions)
- **File**: `extensions/flow-engine/flow-parser.ts` — lines 170–330 (parsing per step type)

### 1.4 DAG-Based Execution with Parallel Waves
Splits flow into DAG segments (contiguous agent steps) and separator segments (fork/conditional/decision). DAG segments run agents in parallel waves based on `blockedBy` dependencies, up to `max_concurrent` limit.

- **File**: `extensions/flow-engine/flow-execution.ts`
  - `runFlow()` — line 74 (main entry point)
  - `splitIntoSegments()` — line 138 (DAG vs separator splitting)
  - `runDagSegment()` — line 164 (wave-based parallel execution with deadlock detection)
  - `computeActiveSteps()` — line 435 (branch exclusivity — only activates reachable steps after fork)

### 1.5 Template Variable Expansion
Expands `{task}`, `{input.NAME}`, `{result.STEP.field}`, `{fork.ID.answer}`, `{fork.ID.notes}`, `{loop.ID.iteration}`, `{loop.ID.max}` in task text, inputs, and other template-aware properties.

- **File**: `extensions/flow-engine/execution.ts`
  - `expandTemplateVariables()` — line 8

### 1.6 Input Wiring Between Steps
Steps declare `inputs:` blocks (nested key:value) that resolve `{result.STEP_ID.summary}` etc. at dispatch time. Agent system prompts use `{input.NAME}` placeholders.

- **File**: `extensions/flow-engine/flow-execution.ts` — lines 230–245 (input resolution at dispatch)
- **File**: `extensions/flow-engine/types.ts` — line 72 (`AgentStep.inputs`)
- **File**: `extensions/flow-engine/flow-parser.ts` — lines 226–233 (inputs block parsing)

### 1.7 Model Role Resolution
Resolves `@planning`, `@coding`, `@compact`, `@fast`, `@vision`, `@research` role aliases to concrete model IDs. Also supports `model-id:thinking-level` suffix syntax.

- **File**: `extensions/flow-engine/model-roles.ts`
  - `resolveModel()` — line 25

### 1.8 Result Parsing
Parses `<result status="...">` XML envelopes from agent output. Extracts status, files, artifacts, summary. Falls back to `status: "unknown"` when no envelope found.

- **File**: `extensions/flow-engine/result-parser.ts`
  - `parseResult()` — line 23
  - `hasArtifactElement()` — line 68

---

## 2. Agent Spawning (Subprocesses)

### 2.1 RPC-Mode Spawning
Agents spawn as `pi --mode rpc` subprocesses. Communication via stdin/stdout JSONL. Task sent via RPC `prompt` command. Supports abort via RPC `abort` command → SIGTERM → SIGKILL cascade.

- **File**: `extensions/flow-engine/execution.ts`
  - `spawnAgent()` — line 33
  - RPC prompt dispatch — line 112
  - Abort signal handling — lines 128–143
  - JSONL event parsing (tool_execution_start/end, message_end, extension_ui_request) — lines 147–210

### 2.2 Mandatory `finish` Tool Call
Guard extension enforces that every agent MUST call the `finish` tool as its final action. Finish tool captures structured result: `{status, summary, files[], artifacts, branch?}`. Max 2 retries if agent forgets.

- **File**: `extensions/flow-engine/guard.ts`
  - `AGENT_REQUIRE_FINISH` env var check — line 54
  - `finish` tool registration — lines 66–100
  - Post-finish blocking — lines 102–108
  - `agent_end` retry logic — lines 110–120

### 2.3 Tool Whitelist Enforcement
Guard extension reads `AGENT_ALLOWED_TOOLS` env var (JSON array). Blocks any tool not in the declared list. `finish` always allowed.

- **File**: `extensions/flow-engine/guard.ts` — lines 25–48

### 2.4 Access Control (File Sandboxing)
Agent frontmatter `access:` block specifies allowed read/write glob patterns and bash deny list. Guard reads rules from `AGENT_ACCESS_RULES` temp file. Blocks reads, writes, grep, and bash redirects outside allowed paths.

- **File**: `extensions/flow-engine/guard.ts` — lines 130–200
- **File**: `extensions/flow-engine/agent-parser.ts` — `parseAccessBlock()` line 180

### 2.5 Decision Branches for Agent Steps
For `agent-decision` and `agent-loop-decision` steps, `AGENT_DECISION_BRANCHES` env var passes valid branch names. The `finish` tool includes a `branch` parameter with `Type.Union` of branch literals.

- **File**: `extensions/flow-engine/guard.ts` — lines 56–65 (branch param in finish schema)
- **File**: `extensions/flow-engine/execution.ts` — line 103 (`decisionBranches` env var)

### 2.6 Extension UI Request Bridging (ask_user in subagents)
Subagent `extension_ui_request` events are captured via JSONL and forwarded to parent session. Responses sent back via `extension_ui_response` RPC command. Queue-based serialization prevents multiple simultaneous prompts.

- **File**: `extensions/flow-engine/execution.ts` — lines 157–170 (JSONL event handling)
- **File**: `extensions/flow-engine/index.ts`
  - `AskUserQueue` class — lines 55–100
  - Queue processing with overlay awareness — lines 82–110

### 2.7 Token Tracking
Accumulated `input` and `output` token counts from `message_end` events. Stored per agent and displayed in cards.

- **File**: `extensions/flow-engine/execution.ts` — lines 192–196 (accumulation)
- **File**: `extensions/flow-engine/types.ts` — line 137 (`AgentResult.tokens`)

### 2.8 Assistant Text & Thinking Text Capture
`message_end` events extract text and thinking blocks. Forwarded via callbacks to dashboard event log for detail view.

- **File**: `extensions/flow-engine/execution.ts` — lines 198–210

---

## 3. Flow Discovery & Registration

### 3.1 Multi-Tier Discovery
Agents and flows discovered from three tiers (lowest to highest priority):
1. Extra package dirs (registered via `flow:register-agents-dir` / `flow:register-flows-dir` events)
2. pi-flows package: `agents/*.md` and `flows/**/*.flow.md`
3. Project-local: `.pi/flows/agents/*.md` and `.pi/flows/flows/**/*.flow.md`

Project-local overrides package on name collision.

- **File**: `extensions/flow-engine/discovery.ts`
  - `discoverAll()` — line 22
  - `discoverAgentsInDir()` — line 86
  - `discoverFlowsInDir()` — line 116 (recursive, subfolder prefix with `:` separator, max 1 subfolder depth)

### 3.2 Flow-to-Command Registration
Every discovered flow is registered as a `/name` command. Commands handle task prompting, gate checking, dashboard wiring, and flow execution.

- **File**: `extensions/flow-engine/index.ts`
  - `registerFlowCommand()` — line 452
  - Flow command handler with task_required/task_prompt support — lines 455–510

### 3.3 Dynamic Re-Discovery
`flow:rediscover` event triggers `init()` re-scan. Newly discovered flows get registered as commands. Used after `agent_write`, `flow_write`, and flow deletion.

- **File**: `extensions/flow-engine/index.ts` — lines 548–557

### 3.4 Package Registration Events
Dependent packages register dirs and extensions via events:
- `flow:register-agents-dir` — adds agent discovery dir
- `flow:register-flows-dir` — adds flow discovery dir + registers new commands
- `flow:register-skills-dir` — adds skill lookup dir
- `flow:register-guard-extension` — adds extra guard extension to all subagents
- `flow:register-gate` — registers a gate check (e.g., model file validation)

- **File**: `extensions/flow-engine/index.ts` — lines 365–415

---

## 4. Interactive Dashboard (TUI)

### 4.1 Grid-Based Agent Cards
Cards arranged in a responsive grid. Each card shows: animated spinner (running), status icon (✓/✗/○), agent label, model role, token counts, duration, last 3 tool calls, loop iteration badge.

- **File**: `extensions/flow-dashboard/agent-card.ts` — `AgentCard` class (full file)
- **File**: `extensions/flow-dashboard/grid-component.ts` — `GridComponent` class
  - `MIN_CARD_WIDTH = 40`, `CARD_HEIGHT = 8` — lines 4–5
  - `computeCols()` — line 15 (responsive column calculation)

### 4.2 Card Registry (Pluggable Metric Renderers)
Three built-in metric types: `default` (empty), `files` (read/written/words), `tests` (pass/fail/commands). Custom metrics registered via `flow:register-card` event.

- **File**: `extensions/flow-dashboard/card-registry.ts`
  - `registerMetric()` — line 12
  - `initCardTypes()` — line 16
  - `getCardRenderer()` — line 23
- **File**: `extensions/flow-dashboard/default-card.ts` — `DefaultCard`
- **File**: `extensions/flow-dashboard/files-card.ts` — `FilesCard` (tracks filesRead, filesWritten, wordCount)
- **File**: `extensions/flow-dashboard/tests-card.ts` — `TestsCard` (parses Jest/Vitest/pytest output)

### 4.3 Agent Dashboard (State Machine)
Modes: `passive` (view only) and `navigate` (arrow keys + Enter to open detail). Tracks cards, event logs, tool history. Spinner timer (120ms interval) for running agents.

- **File**: `extensions/flow-dashboard/agent-dashboard.ts` — `AgentDashboard` class
  - `preloadAgents()` — line 40 (pre-populates pending cards with dependency info)
  - `onAgentStarted()` / `onAgentComplete()` — lines 55–75
  - `onToolCall()` / `onToolResult()` — lines 77–100
  - `onAssistantText()` / `onThinkingText()` — lines 102–115
  - `render()` — line 137 (header with agent count, breadcrumb, grid, footer hints)

### 4.4 Ctrl+O Detail Mode (Agent Inspection Overlay)
Opens a scrollable overlay with full agent history: thinking blocks, assistant text, tool calls with expandable input/output. Two modes: BROWSING (entry-level navigation) and EXPANDED (line-level scroll within a tool call).

- **File**: `extensions/flow-dashboard/agent-detail-overlay.ts` — `createAgentDetailOverlay()`
  - Key bindings: ESC/Backspace close, ↑↓ navigate/scroll, Enter expand/collapse, Ctrl+T toggle thinking
- **File**: `extensions/flow-dashboard/detail-view.ts`
  - `renderDetailView()` — line 89 (builds virtual document then slices viewport)
  - `createDetailScrollState()` — line 8
  - `moveUp()` / `moveDown()` / `toggleExpand()` — lines 14–48
  - `computeExpandedContentLines()` — line 206

### 4.5 Breadcrumb (Workflow Pipeline)
Shows workflow stages with progress: `✓ research → [apply] → deploy`. Only displayed if workflow has >1 stage.

- **File**: `extensions/flow-dashboard/breadcrumb.ts` — `renderBreadcrumb()`

### 4.6 Workflow Registry
Workflows define multi-stage pipelines. Flows map to stages. Most specific workflow preferred (fewest stages).

- **File**: `extensions/flow-dashboard/workflow-registry.ts`
  - `registerWorkflow()` — line 5
  - `resolveWorkflow()` — line 9 (finds workflow + stage index for a flow name)
- **File**: `extensions/flow-dashboard/types.ts` — `WorkflowDefinition`, `WorkflowStage` interfaces

---

## 5. Keyboard Navigation & Input Routing

### 5.1 Dashboard Input Handling
Global terminal input handler routes keys based on state:
- **Passive mode**: Ctrl+O → enter navigate, Ctrl+X → abort flow, Ctrl+A → toggle autonomous
- **Navigate mode**: Arrow keys → grid navigation, Enter → open detail overlay, ESC → back to passive
- **Summary mode**: Ctrl+O → navigate agents, Ctrl+X → dismiss summary, ↑↓ → navigate, Enter → open detail

- **File**: `extensions/flow-engine/index.ts`
  - `handleDashboardInput()` — line 308
  - `handleSummaryInput()` — line 362
  - `navigateCard()` — line 395 (2D grid math using column count)

### 5.2 Overlay Mutual Exclusion
`overlayOpen` flag prevents input handling while an overlay is showing. Ask-user queue waits for overlay to close before showing prompts.

- **File**: `extensions/flow-engine/index.ts` — lines 96–100 (overlay state), lines 82–84 (queue waits)

---

## 6. Flow Summary (Post-Flow)

### 6.1 LLM-Powered Insight Summary
After flow completes, calls `@compact` model to generate bullet-point insights from per-agent results. Shows spinner widget during generation.

- **File**: `extensions/flow-summary/index.ts`
  - `SYSTEM_PROMPT` — line 30
  - LLM call via `completeSimple()` — lines 115–140
  - Spinner widget — lines 97–115

### 6.2 Summary Widget (Boxed TUI)
Bordered box with: flow name, agent count, duration, insight lines (or per-agent fallback), next pipeline step hint, Ctrl+O/Ctrl+X hints.

- **File**: `extensions/flow-summary/index.ts`
  - Summary box rendering — lines 170–245
  - Navigate mode (agent list with card metrics) — lines 155–190

### 6.3 Result Persistence
Saves `.pi/flows/results/<flow>.md` (human-readable) and `.pi/flows/results/<flow>.json` (machine-readable FlowResult) to disk.

- **File**: `extensions/flow-summary/index.ts` — lines 145–175

### 6.4 Summary State Machine
Modes: `summary` (overview) → `navigate` (agent list) → detail overlay. Shared via `getSummaryState()`/`setSummaryState()` module-level state.

- **File**: `extensions/flow-summary/index.ts` — lines 15–30

---

## 7. Architect Tools (Flow/Agent Design)

### 7.1 `agent_catalog` Tool
Returns JSON of all discovered agents with name, description, tools, inputs, card config, source info (`source_type`, `source_path`), and architect metadata. Agents are classified as `"local"` (project .pi/flows/), `"package"` (extension packages), or `"built-in"` (pi-flows). Fallback: uses description as `use_when` when no architect block.

- **File**: `extensions/flow-engine/tools/agent-catalog.ts`

### 7.2 `agent_validate` Tool
Validates agent `.md` content without writing. LSP-style diagnostics: checks frontmatter presence, required fields (name/description/tools), tool name validation against `BASE_TOOLS + dynamicTools`, model role validation, input identifier syntax, access pattern syntax, card config, `{task}` placeholder in body.

- **File**: `extensions/flow-engine/tools/agent-validate.ts`
  - `validateAgentContent()` — line 51
  - `BASE_TOOLS` set — line 21
  - `KNOWN_MODEL_ROLES` set — line 37

### 7.3 `agent_write` Tool
Validates via `agent_validate`, writes to disk, emits `flow:rediscover`.

- **File**: `extensions/flow-engine/tools/agent-write.ts`

### 7.4 `flow_validate` Tool
Validates flow `.md` content. Checks: frontmatter, step headers, agent references against catalog, blockedBy references, DAG cycle detection (Kahn's algorithm), input wiring coverage (warns on missing/extra), template variable syntax, angle-bracket syntax rejection, fork branch targets, agent-loop-decision validation (loop_target/exit_target/max_iterations), deprecation warnings (allowCustom, decisionAgent).

- **File**: `extensions/flow-engine/tools/flow-validate.ts`
  - `validateFlowContent()` — line 23
  - `detectCycle()` — line 370 (Kahn's algorithm)
  - Input coverage validation — lines 395–440

### 7.5 `flow_write` Tool
Validates via `flow_validate`, writes to disk, emits `flow:rediscover`.

- **File**: `extensions/flow-engine/tools/flow-write.ts`

### 7.6 `flow_preview` Tool
Renders structured text preview: flow name, description, steps with types/deps/inputs/routing, dependency graph, custom agents list.

- **File**: `extensions/flow-engine/tools/flow-preview.ts`
  - `renderFlowPreview()` — line 14

### 7.7 `skill_read` Tool
Reads detail files from skills. Validates file is listed in `SKILL.md`. Supports extra skills dirs from dependent packages.

- **File**: `extensions/flow-engine/tools/skill-read.ts`
  - `findSkillDir()` — line 10 (searches extra dirs first, then package dir)

### 7.8 `ask_user` Tool
Main session tool for user interaction: select (with multi-select checkbox overlay), confirm, input. Supports allowNotes, allowCustom.

- **File**: `extensions/flow-engine/tools/ask-user.ts`

### 7.9 `subagent` Tool
Main session tool for ad-hoc agent spawning: single mode (one agent) or parallel mode (array of `{agent, task}`).

- **File**: `extensions/flow-engine/tool.ts`
  - `registerSubagentTool()` — line 6

### 7.10 `flow_results` Tool
LLM-callable tool for reading persisted flow results: `list` (available results), `summary` (per-agent summaries), `agent` (full detail for one agent).

- **File**: `extensions/flow-context/index.ts` — lines 58–160

---

## 8. Flow Workspace (Creation & Editing)

### 8.1 `/flows:new` — New Flow Design
Analyzes conversation context via `@compact` LLM to generate slug/description. Spawns flow-architect agent with replan loop: design → preview → choice (Run / Save & Run / Replan / Cancel).

- **File**: `extensions/flow-workspace/index.ts`
  - `handleNewFlow()` — line 200
  - Conversation context extraction — `extractConversationContext()` line 25
  - Slug generation LLM call — `SLUG_SYSTEM_PROMPT` line 38
  - Replan loop — lines 330–380

### 8.2 `/flows:edit` — Edit Existing Flow
Reads existing flow content, asks for modification request, spawns architect with replan loop: edit → preview → choice (Save / Replan / Cancel). Copies back to original location on save.

- **File**: `extensions/flow-workspace/index.ts`
  - `handleEditFlow()` — line 65
  - Copy-back logic — lines 175–190

### 8.3 `/flows` — Flow Management Menu
Action menu: New flow, List flows, or per-flow actions (Inject context, Edit, Delete).

- **File**: `extensions/flow-context/index.ts` — `/flows` command handler, lines 170–240

### 8.4 `/flows:delete` — Flow Deletion
Deletes flow file, associated custom agents in `.pi/flows/agents/`, and result files. Triggers re-discovery.

- **File**: `extensions/flow-context/index.ts`
  - `deleteFlow()` — line 65

### 8.5 Flow Saving & Persistence
"Save & Run" slugifies flow name, copies to `.pi/flows/flows/custom/<name>.flow.md`, copies custom agents to `.pi/flows/agents/`, re-discovers. Registers as `/custom:<name>` command.

- **File**: `extensions/flow-workspace/index.ts` — lines 380–425

### 8.6 Architect Widget (Design Phase TUI)
Full-width widget rendered above editor during architect design phase. Two modes:
- **Design mode**: Spinner + flow name, agent list (built-in/local/custom with creation status), DAG tree visualization, status bar, last tool call
- **Preview mode**: Structured flow view with metadata, steps with task/deps, dependency graph

Tracks tool calls: `agent_catalog`, `agent_write`, `flow_validate`, `flow_write`, `flow_preview`.

- **File**: `extensions/flow-dashboard/architect-widget.ts` — `createArchitectWidget()`
  - `parseFlowSteps()` — line 100 (lightweight step extraction)
  - `renderDag()` — line 145 (tree rendering with `├──`/`└──` connectors)
  - Design mode layout — lines 250–380
  - Preview mode layout — lines 380–500

### 8.7 Ctrl+O Flow Preview Overlay During Design
During architect phase, Ctrl+O opens full flow preview overlay. Scrollable. Shows all step types with symbols (○ agent, ◇ fork, ◆ conditional, ◈ decision, ↻ loop, ▷ flow-ref), wiring DAG tree, legend.

- **File**: `extensions/flow-dashboard/flow-preview-overlay.ts` — `createFlowPreviewOverlay()`
  - `buildFlowPreviewLines()` — line 37
- **File**: `extensions/flow-workspace/index.ts` — Ctrl+O handler (lines 105–130 in edit, lines 275–300 in new)

### 8.8 Ctrl+X Abort During Design
Ctrl+X during architect phase aborts the spawned architect agent via AbortController.

- **File**: `extensions/flow-workspace/index.ts` — Ctrl+X handler in `onTerminalInput` (lines 100, 270)

---

## 9. Fork & Decision Features

### 9.1 User Fork with Branches
Presents question + options via `ui.select()`. Branch targets shown inline (`option → step-id`). Supports:
- `allowNotes`: prompts for freetext notes after selection → `{fork.ID.notes}`
- `allowCustom`: appends "Other (describe)" option → freetext input
- `multiSelect`: checkbox overlay, all selected branches execute sequentially

- **File**: `extensions/flow-engine/flow-execution.ts` — `executeForkStep()` line 280
- **File**: `extensions/flow-engine/index.ts` — fork UI rendering, lines 215–295

### 9.2 Autonomous Mode (Auto-Decide)
When `agent:` field set on fork + autonomous mode enabled, agent auto-decides the branch. Also: user can select "🤖 Auto-decide (let AI choose)" option at any fork. Ctrl+A toggles autonomous mode globally.

- **File**: `extensions/flow-engine/flow-execution.ts` — autonomous fork handling, lines 285–330
- **File**: `extensions/flow-engine/index.ts` — `AUTO_DECIDE_OPTION`, Ctrl+A handler
- **File**: `extensions/provider-register.ts` — `isAutonomousMode()`, `setAutonomousMode()` (persisted to config)

### 9.3 Fork Context Autowiring
Fork decision context (question, answer, notes, decidedBy) automatically injected into the branch step's context files. Only the immediate branch step receives it.

- **File**: `extensions/flow-engine/flow-execution.ts`
  - `storeForkContext()` — line 340
  - Autowiring into agent step — lines 250–260

### 9.4 Agent Decision Steps
Dispatches a decision agent that calls `finish({branch: "chosen"})`. Routes to the target branch step. Fallback: first branch on failure.

- **File**: `extensions/flow-engine/flow-execution.ts` — `executeAgentDecisionStep()` line 365

### 9.5 Agent Loop Decision Steps
Iterative loops with counter tracking. Agent chooses `"loop"` or `"exit"`. Force-exits at `max_iterations`. Loop iteration emitted as event for card display.

- **File**: `extensions/flow-engine/flow-execution.ts` — `executeAgentLoopDecisionStep()` line 395

---

## 10. Provider & Roles System

### 10.1 Provider Registration (`/provider` command)
Add/edit/remove LLM providers with base URL, API key ($ENV_VAR or literal), API protocol (openai-completions, anthropic-messages). Model catalog with searchable select overlay.

- **File**: `extensions/provider-register.ts`
  - `/provider` command — line 270
  - `registerEntry()` — line 130
  - Default config at `~/.pi/agent/providers.json`

### 10.2 Role Assignment (`/roles` command)
SettingsList overlay to assign models to roles (@planning, @coding, @compact, @fast, @research, @vision, @modelling). SearchableSelectList for model selection. Persisted to config.

- **File**: `extensions/provider-register.ts`
  - `/roles` command — line 175
  - `currentRoles` module-level state — line 140

### 10.3 Session Provider Tracking
Tracks current session's provider and model ID. Updates on `model_select` event. Exposed via `getSessionInfo()`.

- **File**: `extensions/provider-register.ts` — lines 135–145

### 10.4 Model Display Name Resolution
Resolves model IDs to human-friendly names from the model catalog.

- **File**: `extensions/provider-register.ts` — `getModelDisplayName()` line 148

---

## 11. Footer

### 11.1 Composable Footer
Base segments: provider · model, git branch (⎇), file stats (+insertions/-deletions), context window bar (▓░ percentage with color).

- **File**: `extensions/flow-footer.ts`
  - Footer rendering — lines 55–100

### 11.2 Domain Segment Registration
External extensions register custom footer segments via `flow:register-footer-segment` event. Example: autonomous mode indicator ("🤖 auto").

- **File**: `extensions/flow-footer.ts` — lines 30–45
- **File**: `extensions/flow-engine/index.ts` — autonomous mode footer segment registration, line 410

---

## 12. File Tracker

### 12.1 Session-Scoped File Statistics
Tracks file modifications from main session (edit/write tool results) and subagent modifications (via `flow:subagent-tool-result` events). Computes insertions/deletions from diffs.

- **File**: `extensions/file-tracker.ts`
  - `recordEdit()` — line 30 (parses unified diff)
  - `recordWrite()` — line 40
  - `getFileStats()` — line 45
  - Subagent tracking via events — line 65

---

## 13. Agent Frontmatter Features

### 13.1 Dynamic File Access (`context:` field)
Agent frontmatter `context:` specifies files to inject before agent starts. Contents prepended to system prompt.

- **File**: `extensions/flow-engine/agent-parser.ts` — line 37 (parsing)
- **File**: `extensions/flow-engine/execution.ts` — lines 55–60 (injection)

### 13.2 Skills Integration (`skills:` field)
Agent frontmatter `skills:` lists skill names. SKILL.md content resolved from skill dirs and prepended to system prompt.

- **File**: `extensions/flow-engine/execution.ts` — lines 50–55 (skill content injection)
- **File**: `extensions/flow-engine/tools/skill-read.ts` — `findSkillDir()` (searches extra + package dirs)

### 13.3 Card Display Config (`card:` block)
Agent frontmatter `card:` configures dashboard display: `type` (status/metric/progress/log), `label` (display name), `metric` (renderer name: default/files/tests), `role` (display role override).

- **File**: `extensions/flow-engine/agent-parser.ts` — lines 48–55
- **File**: `extensions/flow-engine/types.ts` — `CardConfig` interface, line 7

### 13.4 Architect Metadata (`architect:` block)
Agent frontmatter `architect:` provides metadata for the flow architect: `use_when`, `produces`, `depends_on`, `domain`. Used by `agent_catalog` tool.

- **File**: `extensions/flow-engine/agent-parser.ts` — lines 57–70
- **File**: `extensions/flow-engine/types.ts` — `ArchitectMeta` interface, line 14

### 13.5 Declared Inputs (`inputs:` field)
Agent frontmatter `inputs:` declares expected input names. Used for flow wiring validation. System prompt uses `{input.NAME}`.

- **File**: `extensions/flow-engine/agent-parser.ts` — line 36
- **File**: `extensions/flow-engine/types.ts` — `AgentConfig.inputs`, line 30

### 13.6 Interactive Mode (`interactive:` field)
Agent frontmatter `interactive:` flag for interactive agents.

- **File**: `extensions/flow-engine/agent-parser.ts` — line 33

### 13.7 Thinking Level (`thinking:` field)
Agent frontmatter `thinking:` level (off/minimal/low/medium/high/xhigh). Passed to `pi --thinking` flag.

- **File**: `extensions/flow-engine/agent-parser.ts` — line 31
- **File**: `extensions/flow-engine/execution.ts` — line 42

---

## 14. Built-In Agents

### 14.1 `flow-architect`
Designs custom flows. Model: `@planning`, thinking: high. Tools: agent_catalog, agent_validate, agent_write, flow_validate, flow_write, flow_preview, read, grep, glob. Full reference guide in system prompt.

- **File**: `agents/flow-architect.md`

### 14.2 `flow-decision`
Routes freetext answers to closest branch. Model: `@fast`. Minimal tools (read).

- **File**: `agents/flow-decision.md`

### 14.3 `project-context-reader`
Discovers and reads project planning files, docs, configs. Model: `@coding`. Tools: read, grep, glob. Card: files metric.

- **File**: `agents/project-context-reader.md`

---

## 15. Flow Manager (Concurrency Control)

### 15.1 Single-Flow Mutex
Only one flow can run at a time. `FlowManager` class manages active flow lifecycle.

- **File**: `extensions/flow-engine/index.ts`
  - `FlowManager` class — line 170
  - `isRunning` / `activeFlowName` — lines 180–185
  - `start()` — line 192 (non-blocking, fire-and-forget with lifecycle cleanup)
  - `abort()` — line 188

### 15.2 Main Session Parallel Working
Flow runs as fire-and-forget promise. Main session remains responsive for user input while flow executes in background.

- **File**: `extensions/flow-engine/index.ts` — lines 300–320 (promise lifecycle)

---

## 16. Gate Registry

### 16.1 Flow Gates
External packages register gate checks via `flow:register-gate` event. Gates can block flow execution with a custom message (e.g., "model file validation required").

- **File**: `extensions/flow-engine/index.ts`
  - `GateEntry` interface — line 135
  - `checkGate()` — line 145 (glob pattern matching on flow names)

---

## 17. Event System

### 17.1 Flow Events (pi.events)
| Event | Direction | Description |
|-------|-----------|-------------|
| `flow:complete` | Emitted | Flow finished, carries FlowResult |
| `flow:auto-decision` | Emitted | Autonomous agent made a fork decision |
| `flow:loop-iteration` | Emitted | Loop iteration progress |
| `flow:subagent-tool-call` | Emitted | Subagent called a tool |
| `flow:subagent-tool-result` | Emitted | Subagent tool completed |
| `flow:run` | Listened | Programmatic flow invocation |
| `flow:rediscover` | Listened | Re-scan agents and flows |
| `flow:wire-dashboard` | Listened | Wire dashboard from external extensions |
| `flow:unwire-dashboard` | Listened | Unwire dashboard |
| `flow:get-agents` | Listened | Expose agent map to other extensions |
| `flow:get-flows` | Listened | Expose flow map to other extensions |
| `flow:register-gate` | Listened | Register a gate check |
| `flow:register-agents-dir` | Listened | Add agent discovery directory |
| `flow:register-flows-dir` | Listened | Add flow discovery directory |
| `flow:register-skills-dir` | Listened | Add skill lookup directory |
| `flow:register-guard-extension` | Listened | Add guard extension to subagents |
| `flow:register-footer-segment` | Listened | Add footer segment |
| `flow:register-card` | Listened | Register custom card metric renderer |
| `flow:register-workflow` | Listened | Register workflow definition |
| `flow:set-summary-context` | Listened | Pass tool history + cards to summary |
| `flows:new-request` | Listened | Trigger new flow creation |
| `flows:edit-request` | Listened | Trigger flow editing |

- **Files**: Various — see individual feature sections above

---

## 18. Shared UI Components

### 18.1 SearchableSelectList
Typeahead search with filtered select list. Used in provider/roles overlays.

- **File**: `extensions/shared/searchable-select-list.ts`

### 18.2 CheckboxSelectList
Multi-select with Space toggle, Enter confirm, Esc cancel. Used in ask_user multiSelect and fork multiSelect.

- **File**: `extensions/shared/checkbox-select-list.ts`

### 18.3 Select Overlay
Thin wrapper for `ctx.ui.custom()` with SelectList inside bordered box.

- **File**: `extensions/shared/select-overlay.ts`

---

## 19. Extension Architecture

### 19.1 Single Entry Point
All sub-extensions loaded through one `index.ts` to share a single jiti module graph. Eliminates module identity issues with dynamic imports.

- **File**: `extensions/index.ts`
  - Activation order: provider-register → file-tracker → flow-engine → flow-dashboard → flow-summary → flow-context → flow-workspace → flow-footer

### 19.2 Sub-Extension Modules
| Module | Description |
|--------|-------------|
| `provider-register` | LLM provider/model/role management |
| `file-tracker` | Session file modification tracking |
| `flow-engine` | Core flow parsing, execution, tool registration |
| `flow-dashboard` | TUI grid dashboard, cards, overlays |
| `flow-summary` | Post-flow summary with LLM insights |
| `flow-context` | Flow result management, `/flows` commands, `flow_results` tool |
| `flow-workspace` | Flow creation/editing with architect |
| `flow-footer` | Composable footer bar |

---

## 20. Task Configuration

### 20.1 `task_required` and `task_prompt`
Flow frontmatter `task_required: true` prompts user for task description if no command args. `task_prompt` customizes the prompt text.

- **File**: `extensions/flow-engine/types.ts` — lines 60–61
- **File**: `extensions/flow-engine/flow-parser.ts` — lines 57–58
- **File**: `extensions/flow-engine/index.ts` — lines 465–470 (handler)

### 20.2 Flow Cancellation
`FlowCancelledError` thrown on user ESC at fork or Ctrl+X abort. Caught by `runFlow()` for clean cancellation result.

- **File**: `extensions/flow-engine/flow-execution.ts`
  - `FlowCancelledError` class — line 12
  - Cancellation handling — lines 110–130
