# pi-flows: Consistency & Portability Changes

Research document capturing what needs to change for pi-flows to work correctly on systems other than the development environment (e.g., oh-pi users, clean installs, non-judo projects).

**Root cause discovered**: pi-flows was developed and tested in a judo-rich environment with Opus-class models. On a clean system (oh-pi + pi-flows, no pi-judo, possibly non-Anthropic models), the flow-architect produces wrong flows and wrong previews because of judo-contaminated prompts, untyped output wiring, and implicit assumptions about the agent catalog.

**oh-pi is NOT at fault**. It doesn't register conflicting tools, agents, or commands. The problems are all in pi-flows itself.

---

## Change 1: De-judo the Flow Architect & Add Agent Creation Guidelines

**Priority: 🔴 Critical — this is the immediate fix for broken flows on other systems**

### Problem

`flow-architect.md` is 361 lines with **37 references to judo-specific agents** (`judo-backend-developer`, `judo-model-designer`, `judo-verifier`, `judo-fixer`, `judo-proposal-writer`). These appear in:

- The "Input Wiring (CRITICAL)" section — all examples use judo agents
- The "Agent Loop Decision" section — uses judo-verifier/judo-fixer loop
- The "Project Context Integration" section — hardcodes judo pipeline
- Multiple inline examples throughout the Flow Format Reference

On a clean system, `agent_catalog` returns only pi-flows built-in agents:
- `flow-architect` (orchestration — not useful as a flow step)
- `flow-decision` (routing)
- `project-context-reader` (research)
- `pi-flows-researcher/implementer/verifier/fixer` (for developing pi-flows itself — not general-purpose)

The architect has almost **no useful building blocks** and a system prompt trained on judo patterns. A non-Opus model will follow the examples literally, producing nonsensical flows.

### What Changes

**Replace all judo examples with generic ones.** Use agent names like `researcher`, `implementer`, `reviewer`, `fixer` in all examples.

**Add an "Agent Design Template" section** that teaches the architect HOW to create good agents, not just how to reference existing ones. The template should specify that every agent must have:

1. **Frontmatter contract**:
   - `name`: kebab-case unique identifier
   - `description`: one-line purpose statement
   - `model`: role alias (`@coding`, `@planning`, `@research`, `@fast`, `@compact`, `@vision`)
   - `tools`: comma-separated list of tools the agent needs
   - `inputs`: (optional) declared input names for flow wiring
   - `outputs`: (optional) declared output names the agent produces (see Change 2)

2. **System prompt body** — the agent's "soul":
   - **Role**: What this agent IS (one sentence)
   - **Goal**: What it should accomplish
   - **Guidelines**: How it should work, quality standards, constraints
   - **Input references**: `${{input.NAME}}` for each declared input
   - **Task placeholder**: `${{task}}` to receive the runtime task

3. **Example template** (generic):

```
---
name: code-reviewer
description: Reviews implementation for correctness, bugs, and style issues
model: @coding
tools: read, grep, glob
inputs:
  - implementation_summary
outputs:
  - findings
  - verdict
---

# Role
You are a thorough code reviewer focused on correctness and maintainability.

# Goal
Review the implementation and produce categorized findings.

# Guidelines
- Read ALL changed files before forming opinions
- Categorize issues as: critical, warning, suggestion
- Be specific: cite file paths and line numbers
- If no issues found, say so clearly

# Context
Implementation summary:
${{input.implementation_summary}}

# Task
${{task}}
```

**Add explicit guidance for sparse catalogs**: "When `agent_catalog` returns few agents, you MUST create custom agents with `agent_write` for each distinct role in the flow. Do NOT try to reuse built-in pi-flows agents (like pi-flows-researcher) for unrelated tasks."

### Files Affected

- `pi-flows/agents/flow-architect.md` — Major rewrite of all examples and addition of agent design template section

---

## Change 2: Typed Agent Outputs via Finish Tool

**Priority: 🔴 High — enables reliable cross-agent data flow**

### Problem

Currently, agents communicate results through:
- `summary`: free-text string (always available via `${{result.STEP.summary}}`)
- `artifacts`: untyped string blob (historically XML, accessed via `${{result.STEP.artifacts}}`)
- `files`: array of file paths

The `artifacts` field is the legacy XML output mechanism. The `finish` tool describes it as "Optional structured data (XML or other)". There is no schema, no validation, no contract between producer and consumer. Downstream agents receive raw text and hope for the best.

The `<result>` XML envelope parsing in `result-parser.ts` is a fallback for when agents don't call `finish`. This dual path (finish tool vs XML output) creates confusion.

### What Changes

**Add `outputs` to agent frontmatter.** Agents declare what structured data they produce:

```yaml
outputs:
  - name: findings
    description: Categorized code review findings
  - name: verdict
    description: Overall approval status (approved/needs-changes/rejected)
```

**Build the finish tool dynamically based on declared outputs.** The guard extension already builds the finish tool parameters at spawn time. For each declared output, add a parameter:

```
// Current finish params:
{ status, summary, files, artifacts }

// With outputs declared:
{ status, summary, files, findings, verdict }
```

The `artifacts` field remains as a catch-all for agents that don't declare typed outputs (backward compat).

**Store finish params as typed outputs.** Currently `finishParams` is captured but only `summary`, `files`, `artifacts` are extracted. With typed outputs, each declared output name becomes accessible:

```
${{result.code-reviewer.summary}}    — always available
${{result.code-reviewer.findings}}   — from outputs declaration
${{result.code-reviewer.verdict}}    — from outputs declaration
```

**Expose outputs in agent_catalog.** The catalog already returns `inputs`. Add `outputs` so the flow-architect knows what each agent produces and can wire downstream agents correctly.

**Validate output wiring in flow_validate.** Just like input wiring validation warns when declared inputs aren't wired, output wiring validation can warn when a `${{result.STEP.outputName}}` reference doesn't match a declared output.

### Implementation Details

1. **`agent-parser.ts`**: Parse `outputs:` array from frontmatter (same format as `inputs:` but with optional `description` field)
2. **`types.ts`**: Add `outputs?: Array<{name: string, description?: string}>` to `AgentConfig`
3. **`guard.ts`**: In finish tool construction, iterate `agent.outputs` and add each as a `Type.Optional(Type.String({description}))` parameter
4. **`execution.ts`**: After capturing `finishParams`, extract each declared output name into the result record
5. **`flow-execution.ts`**: Store typed outputs in `ctx.results[stepId]` alongside summary/artifacts/files
6. **`execution.ts` (template expansion)**: Add `${{result.STEP.outputName}}` pattern matching
7. **`tools/agent-catalog.ts`**: Include `outputs` array in catalog response
8. **`tools/flow-validate.ts`**: Validate that `${{result.STEP.x}}` references match declared outputs (warning, not error — for backward compat)
9. **`tools/agent-validate.ts`**: Validate output name identifiers (same rules as input names)

### Files Affected

- `pi-flows/extensions/flow-engine/types.ts` — Add outputs to AgentConfig
- `pi-flows/extensions/flow-engine/agent-parser.ts` — Parse outputs from frontmatter
- `pi-flows/extensions/flow-engine/guard.ts` — Dynamic finish tool params from outputs
- `pi-flows/extensions/flow-engine/execution.ts` — Extract typed outputs from finishParams, add template expansion
- `pi-flows/extensions/flow-engine/flow-execution.ts` — Store typed outputs in results context
- `pi-flows/extensions/flow-engine/tools/agent-catalog.ts` — Expose outputs
- `pi-flows/extensions/flow-engine/tools/flow-validate.ts` — Output wiring validation
- `pi-flows/extensions/flow-engine/tools/agent-validate.ts` — Output name validation
- `pi-flows/agents/flow-architect.md` — Document outputs in the agent template

---

## Change 3: Auto-Discover Extension Tools for Subagents

**Priority: 🟡 Medium — enables package ecosystem to work naturally**

### Problem

When `spawnAgent()` creates a subagent session, it only has access to:
1. Built-in SDK tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) via `TOOL_FACTORIES`
2. Explicitly passed `extraCustomTools` (currently: architect tools like `flow_validate`)

Extension-registered tools (e.g., `ant_colony` from oh-pi, `model_cli` from pi-judo, `web_search` from any search package) are **invisible** to subagents. The `flow:register-tool` event exists but requires extensions to explicitly opt-in — most don't.

This means: if pi-judo registers `model_cli` via `pi.registerTool()`, a subagent that declares `tools: model_cli` in its frontmatter will have the tool **blocked by the guard** because it was never passed to the session, yet agent_validate will say the tool name is valid (since it calls `pi.getAllTools()`). Confusing mismatch.

### What Changes

**Collect ALL extension-registered tools at init and pass them to all subagent sessions.**

Currently, the flow engine collects architect tools via a `capturingPi` wrapper:

```typescript
const architectToolDefs: any[] = [];
const capturingPi = { ...pi, registerTool: (tool) => { architectToolDefs.push(tool); pi.registerTool(tool); } };
```

The change: instead of only capturing architect tools, collect ALL tool definitions from the main session. `pi.getAllTools()` already returns them. At subagent spawn time, pass all of them as `extraCustomTools`.

The guard still enforces the whitelist — only tools declared in the agent's `tools:` frontmatter are allowed. This doesn't change. The only change is that the tools are **available to be allowed** if the agent declares them.

**Remove the `flow:register-tool` event.** It becomes unnecessary when all tools are automatically available. (Or keep it as a deprecated alias that does nothing, for backward compat.)

### Implementation Details

1. **`flow-engine/index.ts`**: After all extensions are loaded (on `session_start`), call `pi.getAllTools()` and store the tool definitions. Pass them as `extraCustomTools` to all `spawnAgent()` calls.
2. **Timing**: Extension tools are registered during extension activation, which happens before `session_start`. So `pi.getAllTools()` in `session_start` will have everything.
3. **Alternative**: Use `registeredExtensionTools` array (already exists) but populate it from `pi.getAllTools()` instead of requiring `flow:register-tool` events.

### Files Affected

- `pi-flows/extensions/flow-engine/index.ts` — Collect all tools at session_start, remove or deprecate `flow:register-tool`
- `pi-flows/extensions/flow-engine/execution.ts` — No changes (already accepts `extraCustomTools`)
- `pi-flows/agents/flow-architect.md` — Update tool documentation to reflect that extension tools are auto-discovered

---

## Change 4: Flow File Format Evaluation

**Priority: 🟡 Medium — design decision, large migration cost**

### Problem

Both agents (`.md`) and flows (`.flow.md`) use markdown with YAML frontmatter. This creates issues:

1. **Markdown-in-markdown collision**: Agent system prompts contain markdown headers (`## Section`). The flow parser uses `## step-id` as step delimiters. If an agent's task text or system prompt contains `##`, the parser can break or misparse.

2. **Triple-layer nesting**: An LLM generating a flow must produce markdown containing YAML multiline scalars containing markdown-formatted task descriptions. Each layer has its own escaping rules.

3. **Hand-rolled parser**: `flow-parser.ts` is 690 lines of custom YAML-subset parsing. It handles `>` (folded) and `|` (literal) multiline scalars, nested key-value blocks, list items — but edge cases remain.

4. **Agent bodies have no collision risk**: Agent `.md` files are simple — one frontmatter block, one body. The `##` overloading only affects flows.

### Analysis

| Format | Suitability for Agents | Suitability for Flows |
|--------|----------------------|----------------------|
| `.md` (current) | ✅ Excellent — prose-heavy, one body block | ⚠️ `##` collision with markdown content |
| `.yaml` | ❌ Verbose for system prompts | ✅ Proper structure, standard parser |
| `.xml` | ❌ Painful for prose | ❌ Verbose, LLMs generate it poorly |
| `.toml` | ❌ Limited nesting | ⚠️ OK but unfamiliar |

### Recommendation

**Keep `.md` for agents.** They're prose-heavy documents. The format works perfectly.

**Consider `.flow.yaml` for flows.** Flows are pure structure — step definitions, wiring, dependencies. No prose body. A standard YAML file would:
- Eliminate the custom parser (use a real YAML library or the existing subset parser against actual YAML syntax)
- Remove the `##` collision problem entirely
- Make LLM generation more reliable (YAML is well-represented in training data)
- Allow proper multiline task strings with `|` and `>` without markdown header collision

Example `.flow.yaml`:

```yaml
name: my-flow
description: Research, implement, and verify changes
task_required: true
max_concurrent: 2

steps:
  - id: researcher
    agent: researcher
    task: >
      Research the codebase for: ${{task}}

  - id: implementer
    agent: implementer
    blockedBy: [researcher]
    task: Implement based on research
    inputs:
      research_output: ${{result.researcher.summary}}

  - id: reviewer
    agent: code-reviewer
    blockedBy: [implementer]
    task: Review the implementation
    inputs:
      implementation_summary: ${{result.implementer.summary}}

  - id: verify-loop
    type: agent-loop-decision
    agent: flow-decision
    task: >
      Evaluate: ${{result.reviewer.findings}}
      Loop if critical issues found.
    loop_target: implementer
    exit_target: done
    max_iterations: 3

  - id: done
    agent: summarizer
    task: Summarize all changes for ${{task}}
```

**Migration cost is significant**: parser, validator, preview, architect prompt, all existing `.flow.md` files, discovery logic, documentation. This should be a separate dedicated change, not bundled with the critical fixes.

**Interim mitigation**: For Change 1, ensure the flow-architect prompt's examples use YAML multiline scalars (`>`, `|`) correctly and don't include markdown headers in task text. This avoids the collision without changing the format.

---

## Change 5: Backspace Navigation in /roles, /provider, /catalog

**Priority: 🟢 Low — UX polish, but affects every user on every session**

### Problem

The three command overlays (`/roles`, `/provider`, `/catalog`) have inconsistent back-navigation behavior. Users expect Backspace (or Esc) from a sub-menu to return to the parent menu, not exit the command entirely.

**Current behavior**:

| Command | Has Loop | Backspace/Esc from sub-action | Expected |
|---------|----------|-------------------------------|----------|
| `/catalog` | ✅ `while(true)` | Goes back to catalog browse | ✅ Correct |
| `/provider` | ⚠️ `while(true)` but broken | Exits command after add/edit/remove completes | ❌ Should loop back |
| `/roles` | ❌ No loop | Exits command after any action | ❌ Should loop back |

The overlay helpers already handle Backspace correctly at the component level — `selectOverlay` returns `null` on Backspace, `settingsOverlay` closes on Backspace when not in a submenu. The problem is entirely in the **command handlers** that treat completion as exit rather than loop-back.

### What Changes

**`/provider` handler**: Replace the `return` at the end of the `while(true)` body with `continue`. Currently line ~639 reads `return; // action completed, exit loop`. After add, the handler should loop back to show the updated provider list. After edit, same. After remove, it already `continue`s on cancel but `return`s after deletion — should `continue`. Only Esc/Backspace from the top-level provider list (returning `null` from `selectOverlay`) should `return`.

**`/roles` handler**: Wrap the entire handler body in a `while(true)` loop, matching the pattern used by `/catalog`. After each action (edit roles, save preset, load preset, delete preset), `continue` back to the top menu instead of `return`ing. Only `if (!topChoice) return;` exits the command (user pressed Esc/Backspace on the top menu).

**`/catalog` handler**: Already correct — no changes needed. This is the reference pattern.

### Implementation Pattern

The correct pattern (from `/catalog`):

```typescript
handler: async (_args, ctx) => {
  while (true) {
    const choice = await selectOverlay(ctx, "Title", items);
    if (!choice) return;  // Esc/Backspace on top menu → exit command

    if (choice === "__action__") {
      // ... do action ...
      continue;  // ← back to top menu, NOT return
    }

    // ... other actions ...
    continue;  // ← always loop back
  }
}
```

### Files Affected

- `pi-flows/extensions/provider-register.ts` — `/provider` handler: replace terminal `return` with `continue`; `/roles` handler: wrap in `while(true)` loop, replace `return`s with `continue`

---

## Change Dependency & Ordering

```
Change 1 (de-judo architect)          ← Do FIRST, fixes immediate breakage
    │
    ├── Change 2 (typed outputs)      ← Builds on new architect template
    │       │
    │       └── Change 4 (format)     ← Can reference outputs in new format
    │
    ├── Change 3 (tool discovery)     ← Independent, quick win
    │
    └── Change 5 (backspace nav)      ← Independent, quick win
```

**Recommended execution order:**
1. **Change 1** — Immediate. Fixes broken flows for all non-judo users.
2. **Change 5** — Quick win. Single file, ~20 lines changed, improves UX for everyone.
3. **Change 3** — Quick follow-up. Small code change, big ecosystem benefit.
4. **Change 2** — Design-heavy. Requires careful API design for outputs.
5. **Change 4** — Future. Requires migration plan for existing flows.

---

## Appendix: oh-pi Compatibility Notes

Verified through package inspection (`oh-pi@0.1.85`):

- **No agent conflicts**: oh-pi's `pi` manifest declares `extensions`, `skills`, `prompts`, `themes` — no `agents` field. Its `pi-package/agents/` directory contains AGENTS.md role templates (colony-operator, fullstack-developer, etc.) that are copied to `~/.pi/agent/AGENTS.md` by the configurator. These are NOT flow-engine agents.

- **No tool conflicts**: oh-pi registers `ant_colony`, `bg_colony_status`, `bash` (override), `bg_status`. None conflict with pi-flows tools (`flow_validate`, `flow_preview`, `flow_write`, `agent_catalog`, `agent_validate`, `agent_write`, `subagent`, `ask_user`, `skill_read`, `flow_results`).

- **Footer overlap**: Both oh-pi (`custom-footer.ts`) and pi-flows (`flow-footer.ts`) call `ctx.ui.setFooter()`. Only one wins. This is cosmetic, not a correctness issue. The last extension to call `setFooter` takes precedence.

- **Model config gap**: oh-pi writes `~/.pi/agent/settings.json`, `auth.json`, `models.json`. pi-flows reads `~/.pi/agent/providers.json` for role mappings. These are DIFFERENT files. On an oh-pi-only system, `providers.json` doesn't exist, so pi-flows falls back to hardcoded Anthropic defaults. If the user doesn't have Anthropic keys, `@planning` resolution fails or picks an unavailable model. **This is a pi-flows problem** — the role system should fall back to the session's active model when a role can't be resolved.
