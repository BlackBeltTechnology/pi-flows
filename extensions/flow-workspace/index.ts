// ---------------------------------------------------------------------------
// Flow Workspace Extension
//
// Handles flow creation and editing workflows:
//   - flows:new-request — analyze conversation, design flow with architect,
//     replan loop, save/run with dashboard
//   - flows:edit-request — edit existing flow with architect + replan loop
//
// All user interaction goes through events (flow:prompt-request/response,
// flow:architect-* lifecycle events). No ctx.ui references.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  generateSummary,
  buildSessionContext,
  getLatestCompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { createStagingDir, wipeStagingDir, promoteStagingToFinal, STAGING_AGENTS, STAGING_FLOWS } from "./staging.js";
import { join } from "node:path";
import { emitPromptAndAwait } from "../flow-engine/flow-prompt.js";
import { parseFlowYamlString } from "../flow-engine/flow-parser-yaml.js";
import { resolveModel } from "../flow-engine/model-roles.js";
import type { AgentStep } from "../flow-engine/types.js";

/** Parse flow YAML content into a simplified metadata object for dashboard events. */
function parseFlowForDashboard(content: string): { name: string; description: string; maxConcurrent: number; steps: Array<{ id: string; agentName?: string; blockedBy: string[]; stepType?: string; loopTarget?: string; exitTarget?: string }> } {
  try {
    const flow = parseFlowYamlString(content, "<preview>");
    const steps = flow.steps.map(s => {
      const base: { id: string; agentName?: string; blockedBy: string[]; stepType?: string; loopTarget?: string; exitTarget?: string } = {
        id: s.id,
        blockedBy: ('blockedBy' in s ? s.blockedBy : undefined) || [],
        stepType: s.stepType,
      };
      if ("agent" in s && s.agent) base.agentName = s.agent as string;
      if ("loop_target" in s && s.loop_target) base.loopTarget = s.loop_target as string;
      if ("exit_target" in s && s.exit_target) base.exitTarget = s.exit_target as string;
      return base;
    });
    return { name: flow.name, description: flow.description, maxConcurrent: flow.max_concurrent || 0, steps };
  } catch {
    // Graceful fallback: extract basics via regex
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    return { name: nameMatch?.[1]?.trim() || "", description: descMatch?.[1]?.trim() || "", maxConcurrent: 0, steps: [] };
  }
}

// Module-scoped flag: true when a flow is running from staging (non-saved "Run" path)
let runningFromStaging = false;

// Module-scoped flag: true when an architect session is active
let architectRunning = false;

// Module-scoped AbortController for the running architect agent
let architectAbort: AbortController | null = null;

// ---- Helpers --------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Extract user/assistant text messages from session entries for context.
 * Used for slug generation and as a fallback when generateArchitectContext() fails.
 * The architect path uses generateArchitectContext() for richer structured summaries.
 */
function extractConversationContext(entries: any[]): string {
  const messages: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    if (text.trim()) {
      messages.push(`[${role}]: ${text.slice(0, 2000)}`);
    }
  }
  // Return last ~10 messages for context (don't overwhelm the compact model)
  return messages.slice(-10).join("\n\n");
}

// Custom instructions for flow-architect focused summarization
const ARCHITECT_SUMMARY_INSTRUCTIONS =
  "Focus on: what the user wants to build or change, architectural decisions discussed, " +
  "file structure and code patterns explored, tools and libraries mentioned, " +
  "and any specific requirements or constraints stated.";

/**
 * Generate a structured session summary for the flow-architect using the SDK's
 * generateSummary() with the @compact model role.
 *
 * Falls back to extractConversationContext() if model resolution fails, API key
 * is missing, or generateSummary() throws.
 *
 * Returns null if conversation is too short (< 50 chars) to summarize.
 */
async function generateArchitectContext(
  pi: ExtensionAPI,
): Promise<string | null> {
  // Get session entries via event (no ctx.sessionManager dependency)
  const sessionData: any = {};
  pi.events.emit("flow:get-session-entries", sessionData);
  const entries: SessionEntry[] = sessionData.entries ?? [];
  if (entries.length === 0) return null;

  // Build the resolved message list (handles compaction, branches, custom messages)
  const sessionContext = buildSessionContext(entries);
  const messages = sessionContext.messages;
  if (messages.length === 0) return null;

  // Quick check: if conversation is very short, skip summary generation
  const fallbackContext = extractConversationContext(entries);
  if (fallbackContext.length <= 50) return null;

  try {
    // Resolve @compact via the shared model:resolve event (with registry fallback).
    const spawnCtx = getSpawnContext(pi);
    let model: any;
    try {
      const resolved = resolveModel(pi, "@compact");
      model = resolved.model;
      if (!model && spawnCtx.modelRegistry && resolved.modelId) {
        const [provider, ...modelParts] = resolved.modelId.split("/");
        if (provider && modelParts.length > 0) {
          model = spawnCtx.modelRegistry.find(provider, modelParts.join("/"));
        }
      }
    } catch {
      return fallbackContext;
    }
    if (!model || !spawnCtx.modelRegistry) {
      return fallbackContext;
    }

    const auth = await spawnCtx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return fallbackContext;
    }

    // Check for existing compaction summary for incremental update
    const latestCompaction = getLatestCompactionEntry(entries);
    const previousSummary = latestCompaction?.summary;

    // Generate structured summary
    const summary = await generateSummary(
      messages,
      model,
      4096,          // reserveTokens — output capped at ~3276 tokens
      auth.apiKey,
      auth.headers,  // headers — forward for dynamic auth
      undefined,     // signal — no abort for this quick call
      ARCHITECT_SUMMARY_INSTRUCTIONS,
      previousSummary,
    );

    return summary;
  } catch {
    // Fallback: any failure (API error, timeout, etc.) — use legacy extraction
    return fallbackContext;
  }
}

// System prompt for slug/description generation
const SLUG_SYSTEM_PROMPT = `You generate a change slug and description from conversation context.

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation
- If the conversation clearly describes a task/feature/change, return:
  {"slug": "short-kebab-case-slug", "desc": "One sentence description of the change"}
- If the conversation is too vague or has no actionable content, return:
  {"needsMore": true}
- slug: max 50 chars, lowercase, kebab-case, no special chars
- desc: max 120 chars, imperative mood ("Add X", "Fix Y", "Implement Z")`;

/** Get spawn context (tools, auth, model registry) from flow-engine via events */
function getSpawnContext(pi: ExtensionAPI): { tools: any[]; authStorage: any; modelRegistry: any; extraAgentExtensions: any[] } {
  const spawnCtx: any = {};
  pi.events.emit("flow:get-spawn-context", spawnCtx);
  return {
    tools: spawnCtx.extensionTools ?? [],
    authStorage: spawnCtx.authStorage,
    modelRegistry: spawnCtx.modelRegistry,
    extraAgentExtensions: spawnCtx.extraAgentExtensions ?? [],
  };
}

// ---- Flow edit handler ----------------------------------------------------

async function handleEditFlow(
  pi: ExtensionAPI,
  projectRoot: string,
  preselectedFlowName?: string,
  preselectedFlowPath?: string,
  preselectedModificationRequest?: string,
): Promise<void> {
  let selectedFlow: { name: string; path: string } | undefined;

  // Use preselected flow if provided
  if (preselectedFlowName && preselectedFlowPath && existsSync(preselectedFlowPath)) {
    selectedFlow = { name: preselectedFlowName, path: preselectedFlowPath };
  } else {
    // Discover available flows
    const flowFiles: { name: string; path: string }[] = [];

    const savedFlowsDir = join(projectRoot, ".pi", "flows", "flows");
    if (existsSync(savedFlowsDir)) {
      try {
        const { readdirSync, statSync } = await import("node:fs");
        for (const entry of readdirSync(savedFlowsDir)) {
          const entryPath = join(savedFlowsDir, entry);
          if (entry.endsWith(".yaml")) {
            flowFiles.push({ name: entry.replace(".yaml", ""), path: entryPath });
          } else {
            try {
              if (statSync(entryPath).isDirectory()) {
                for (const sub of readdirSync(entryPath)) {
                  if (sub.endsWith(".yaml")) {
                    const name = `${entry}:${sub.replace(".yaml", "")}`;
                    flowFiles.push({ name, path: join(entryPath, sub) });
                  }
                }
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }

    if (flowFiles.length === 0) {
      // TUI-only error: dashboard reducer's `if (!state) return null;` guard
      // drops architect_error before architect_context_generating creates state.
      // See: openspec/changes/archive/2026-05-11-align-with-dashboard-plugins/
      //      DASHBOARD-DELEGATION-BRIEF.md
      pi.events.emit("flow:architect-init-error", { reason: "no-flows" });
      pi.events.emit("flow:architect-complete", { choice: "error" });
      architectRunning = false;
      return;
    }

    const flowChoice = await emitPromptAndAwait(pi, {
      pipeline: "architect-edit",
      type: "select",
      question: "Select flow to edit:",
      options: flowFiles.map(f => f.name),
    });
    if (flowChoice.cancelled || !flowChoice.answer) {
      pi.events.emit("flow:architect-cancelled", { phase: "flow-selection" });
      pi.events.emit("flow:architect-complete", { choice: "cancel" });
      architectRunning = false;
      return;
    }

    selectedFlow = flowFiles.find(f => f.name === flowChoice.answer);
    if (!selectedFlow) {
      architectRunning = false;
      return;
    }
  }

  // Read the existing flow content
  const existingContent = readFileSync(selectedFlow.path, "utf-8");

  // Ask what to change (skip if provided upfront by dashboard)
  let modificationRequest = preselectedModificationRequest?.trim() || "";
  if (!modificationRequest) {
    const modResult = await emitPromptAndAwait(pi, {
      pipeline: "architect-edit",
      type: "input",
      question: "How should this flow be updated?",
    });
    if (modResult.cancelled || !modResult.answer) {
      pi.events.emit("flow:architect-cancelled", { phase: "modification-request" });
      pi.events.emit("flow:architect-complete", { choice: "cancel" });
      architectRunning = false;
      return;
    }
    modificationRequest = modResult.answer;
  }

  // Load architect agent config
  let pkgRoot: string;
  let architectConfig: any;
  try {
    const { resolvePackageRoot } = await import("../flow-engine/discovery.js");
    pkgRoot = resolvePackageRoot(import.meta.url);
    const { parseAgentFile } = await import("../flow-engine/agent-parser.js");
    architectConfig = parseAgentFile(join(pkgRoot, "agents", "flow-architect.md"));
  } catch {
    // TUI-only error: dashboard reducer guard drops architect_error before state exists.
    pi.events.emit("flow:architect-init-error", { reason: "agent-not-found" });
    pi.events.emit("flow:architect-complete", { choice: "error" });
    architectRunning = false;
    return;
  }

  // Get discovered agents for source resolution
  const agentsQuery: any = {};
  pi.events.emit("flow:get-agents", agentsQuery);
  const discoveredAgentsMap: Map<string, any> = agentsQuery.agents ?? new Map();

  // Resolve agent source type: local if under .pi/, built-in otherwise
  const piLocalPrefix = join(projectRoot, ".pi");
  const resolveAgentType = (agentName: string): "built-in" | "local" => {
    const config = discoveredAgentsMap.get(agentName);
    if (config?.source && config.source.startsWith(piLocalPrefix)) return "local";
    return "built-in";
  };

  // Set up staging directory for architect session
  createStagingDir(projectRoot);
  pi.events.emit("flow:register-agents-dir", { dir: join(projectRoot, STAGING_AGENTS) });

  const stagingInstructions = `\n\nIMPORTANT: Write all agent files to ${STAGING_AGENTS}/ and all flow files to ${STAGING_FLOWS}/ (these are staging directories).`;
  const task = `Modify this existing flow:\n\n${existingContent}\n\nModification request: ${modificationRequest}${stagingInstructions}`;
  const templateCtx = {
    task,
    inputs: {} as Record<string, string>,
    results: {} as Record<string, any>,
    forks: {} as Record<string, any>,
  };

  // Generate structured session summary
  pi.events.emit("flow:architect-context-generating", { mode: "edit" });
  const editArchitectContext = await generateArchitectContext(pi);
  pi.events.emit("flow:architect-context-ready", { hasContext: !!editArchitectContext });

  const { spawnAgent } = await import("../flow-engine/execution.js");
  let choice = "";
  let flowPath = "";
  let replanNotes = "";
  const createdFiles: string[] = [];
  const allCreatedFiles = new Set<string>();
  let iteration = 0;

  while (true) {
    iteration++;
    const currentTask = replanNotes
      ? `${task}\n\nReplan notes: ${replanNotes}`
      : task;

    // Resolve architect model for display
    let architectResolvedModel = "";
    let architectModelAlias = architectConfig.model || "";
    try {
      const { modelId } = resolveModel(pi, architectConfig.model, architectConfig.thinking);
      architectResolvedModel = modelId;
    } catch { /* model resolution may fail — non-fatal for display */ }

    // Emit architect-started (for each iteration)
    pi.events.emit("flow:architect-started", {
      mode: "edit",
      existingFlowContent: existingContent,
      iteration,
      resolvedModel: architectResolvedModel,
      modelAlias: architectModelAlias,
    });

    architectAbort = new AbortController();

    // Listen for abort events
    const unsubAbort = pi.events.on("flow:architect-abort", () => {
      architectAbort?.abort();
    });

    const spawnCtx = getSpawnContext(pi);
    const result = await spawnAgent({
      agent: architectConfig,
      task: currentTask,
      templateContext: { ...templateCtx, task: currentTask },
      pi,
      cwd: projectRoot,
      authStorage: spawnCtx.authStorage,
      modelRegistry: spawnCtx.modelRegistry,
      extraAgentExtensions: spawnCtx.extraAgentExtensions,
      extraCustomTools: spawnCtx.tools,
      preambleSections: editArchitectContext
        ? [
            `## Session Summary\n\nThe following is a structured summary of the user's main session that led to this flow edit request. Use it to understand what the user is trying to change and why:\n\n${editArchitectContext}`,
          ]
        : undefined,
      signal: architectAbort.signal,
      onToolCall: (toolName, input) => {
        pi.events.emit("flow:architect-tool-call", { toolName, input });
      },
      onToolResult: (toolName, output, isError) => {
        pi.events.emit("flow:architect-tool-result", { toolName, output, isError });
      },
      onAssistantText: (text) => {
        pi.events.emit("flow:architect-text", { kind: "assistant", text });
      },
      onThinkingText: (text) => {
        pi.events.emit("flow:architect-text", { kind: "thinking", text });
      },
    });

    unsubAbort();
    architectAbort = null;

    // If aborted, treat as cancel
    if (!result.success && result.result?.summary === "Aborted by user") {
      choice = "Cancel";
      pi.events.emit("flow:architect-cancelled", { phase: "abort" });
      break;
    }

    flowPath = "";
    createdFiles.length = 0;

    for (const tc of result.toolCalls) {
      if (tc.toolName === "flow_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { flowPath = path; createdFiles.push(path); allCreatedFiles.add(path); }
      }
      if (tc.toolName === "agent_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { createdFiles.push(path); allCreatedFiles.add(path); }
      }
    }

    if (!flowPath) {
      // Architect failed to produce a flow
      const summary = result.result?.summary || result.output?.slice(0, 500) || "No details available";
      pi.events.emit("flow:architect-error", { summary });

      const retryChoice = await emitPromptAndAwait(pi, {
        pipeline: "architect-edit",
        type: "select",
        question: `Architect couldn't produce a flow:\n${summary}\n\nWhat would you like to do?`,
        options: ["Retry", "Cancel"],
      });
      if (retryChoice.cancelled || retryChoice.answer !== "Retry") {
        pi.events.emit("flow:architect-cancelled", { phase: "save-decision" });
        break;
      }
      const notesResult = await emitPromptAndAwait(pi, {
        pipeline: "architect-edit",
        type: "input",
        question: "Additional guidance for the architect:",
      });
      if (notesResult.cancelled || !notesResult.answer) {
        choice = "Cancel";
        pi.events.emit("flow:architect-cancelled", { phase: "replan-notes" });
        break;
      }
      replanNotes = notesResult.answer;
      pi.events.emit("flow:architect-replan", { iteration: iteration + 1, notes: replanNotes });
      continue;
    }

    // Emit preview with flow contents
    const flowContents: Array<{ name: string; content: string }> = [];
    for (const f of createdFiles) {
      if (f.endsWith(".yaml") && existsSync(f)) {
        try {
          flowContents.push({ name: f, content: readFileSync(f, "utf-8") });
        } catch { /* ignore */ }
      }
    }
    const parsedFlows = flowContents.map(f => parseFlowForDashboard(f.content));
    pi.events.emit("flow:architect-preview", { flows: flowContents, parsedFlows, flowPath, createdFiles });

    choice = await emitPromptAndAwait(pi, {
      pipeline: "architect-edit",
      type: "select",
      question: "What would you like to do?",
      options: ["Save", "Replan"],
    }).then(r => r.cancelled ? "Cancel" : (r.answer || "Cancel"));

    if (choice === "Replan") {
      const notesResult = await emitPromptAndAwait(pi, {
        pipeline: "architect-edit",
        type: "input",
        question: "What should be changed?",
      });
      if (notesResult.cancelled || !notesResult.answer) {
        choice = "Cancel";
        pi.events.emit("flow:architect-cancelled", { phase: "replan-notes" });
        break;
      }
      replanNotes = notesResult.answer;
      wipeStagingDir(projectRoot);
      createStagingDir(projectRoot);
      createdFiles.length = 0;
      flowPath = "";
      pi.events.emit("flow:architect-replan", { iteration: iteration + 1, notes: replanNotes });
      continue;
    }

    break;
  }

  if (choice === "Cancel" || !flowPath) {
    wipeStagingDir(projectRoot);
    if (choice !== "Cancel") {
      pi.events.emit("flow:architect-cancelled", { phase: "save-decision" });
    }
    pi.events.emit("flow:architect-complete", { choice: "cancel" });
    architectRunning = false;
    return;
  }

  // Save: copy the edited flow back to the original location
  if (choice === "Save") {
    try {
      // Promote staging: copy agents to final, copy flow to original path
      const stagingAgentsDir = join(projectRoot, STAGING_AGENTS);
      const finalAgentsDir = join(projectRoot, ".pi", "flows", "agents");
      mkdirSync(finalAgentsDir, { recursive: true });
      if (existsSync(stagingAgentsDir)) {
        const { readdirSync } = await import("node:fs");
        for (const file of readdirSync(stagingAgentsDir)) {
          if (file.endsWith(".md")) {
            copyFileSync(join(stagingAgentsDir, file), join(finalAgentsDir, file));
          }
        }
      }
      // Copy the staged flow to the original flow's location
      if (flowPath && existsSync(flowPath)) {
        copyFileSync(flowPath, selectedFlow.path);
      }
      wipeStagingDir(projectRoot);
      pi.events.emit("flow:rediscover", {});
      pi.events.emit("flow:architect-saved", {
        flowName: selectedFlow.name,
        flowPath: selectedFlow.path,
        mode: "edit",
      });
    } catch (err: any) {
      pi.events.emit("flow:architect-error", { phase: "save", error: err.message });
    }
  }

  pi.events.emit("flow:architect-complete", { choice: "save", flowName: selectedFlow.name, flowPath: selectedFlow.path });
  architectRunning = false;
}

// ---- Flow creation handler ------------------------------------------------

async function handleNewFlow(
  pi: ExtensionAPI,
  projectRoot: string,
  description: string | undefined,
): Promise<void> {
  // Step 1: Determine description
  let desc = description?.trim() || "";

  if (!desc) {
    // Try to generate from conversation context via events (no ctx.sessionManager/modelRegistry)
    pi.events.emit("flow:architect-context-generating", { mode: "new" });

    const sessionData: any = {};
    pi.events.emit("flow:get-session-entries", sessionData);
    const entries = sessionData.entries ?? [];
    const convoContext = extractConversationContext(entries);

    if (convoContext.length > 50) {
      try {
        let model: any = null;
        const spawnCtx = getSpawnContext(pi);
        try {
          const resolved = resolveModel(pi, "@compact");
          model = resolved.model;
          if (!model && spawnCtx.modelRegistry && resolved.modelId) {
            const [provider, ...modelParts] = resolved.modelId.split("/");
            if (provider && modelParts.length > 0) {
              model = spawnCtx.modelRegistry.find(provider, modelParts.join("/"));
            }
          }
        } catch { /* fall through to ask user */ }

        if (model && spawnCtx.modelRegistry) {
          const auth = await spawnCtx.modelRegistry.getApiKeyAndHeaders(model);
          if (auth.ok) {
            const { completeSimple } = await import("@earendil-works/pi-ai");
            const response = await completeSimple(model, {
              systemPrompt: SLUG_SYSTEM_PROMPT,
              messages: [{
                role: "user" as const,
                content: [{ type: "text" as const, text: convoContext }],
                timestamp: Date.now(),
              }],
            }, { apiKey: auth.apiKey, headers: auth.headers });

            const text = response.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");

            try {
              const parsed = JSON.parse(text.trim());
              if (!parsed.needsMore && parsed.desc) {
                desc = parsed.desc;
              }
            } catch {
              // JSON parse failed — fall through to ask user
            }
          }
        }
      } catch {
        // Model call failed — fall through to ask user
      }
    }

    pi.events.emit("flow:architect-context-ready", { hasContext: !!desc });

    // Fallback: ask user if we couldn't generate
    if (!desc) {
      const userDescResult = await emitPromptAndAwait(pi, {
        pipeline: "architect-new",
        type: "input",
        question: "Describe what you want to build:",
      });
      if (userDescResult.cancelled || !userDescResult.answer) {
        pi.events.emit("flow:architect-cancelled", { phase: "description" });
        pi.events.emit("flow:architect-complete", { choice: "cancel" });
        architectRunning = false;
        return;
      }
      desc = userDescResult.answer;
    }
  }

  // Step 2: Load architect agent config
  let pkgRoot: string;
  let architectConfig: any;
  try {
    const { resolvePackageRoot } = await import("../flow-engine/discovery.js");
    pkgRoot = resolvePackageRoot(import.meta.url);
    const { parseAgentFile } = await import("../flow-engine/agent-parser.js");
    architectConfig = parseAgentFile(join(pkgRoot, "agents", "flow-architect.md"));
  } catch {
    // TUI-only error: dashboard reducer guard drops architect_error before state exists.
    pi.events.emit("flow:architect-init-error", { reason: "agent-not-found" });
    pi.events.emit("flow:architect-complete", { choice: "error" });
    architectRunning = false;
    return;
  }

  // Step 3: Set up staging directory and register for discovery
  createStagingDir(projectRoot);
  pi.events.emit("flow:register-agents-dir", { dir: join(projectRoot, STAGING_AGENTS) });

  const templateCtx = {
    task: desc,
    inputs: {} as Record<string, string>,
    results: {} as Record<string, any>,
    forks: {} as Record<string, any>,
  };

  // Generate structured session summary to give the architect awareness of what led to this flow request.
  // Only generate if we haven't already done context analysis above (when desc was empty).
  let architectContext: string | null = null;
  if (description?.trim()) {
    // Description was provided upfront, so we haven't done context generation yet
    pi.events.emit("flow:architect-context-generating", { mode: "new" });
    architectContext = await generateArchitectContext(pi);
    pi.events.emit("flow:architect-context-ready", { hasContext: !!architectContext });
  } else {
    // Context was already generated during the desc discovery phase above
    architectContext = await generateArchitectContext(pi);
  }

  // Step 4: Spawn architect subagent (with replan loop)
  const { spawnAgent } = await import("../flow-engine/execution.js");
  let choice = "";
  let flowPath = "";
  let replanNotes = "";
  const createdFiles: string[] = [];
  const allCreatedFiles = new Set<string>();
  let iteration = 0;

  while (true) {
    iteration++;
    const stagingInstructions = `\n\nIMPORTANT: Write all agent files to ${STAGING_AGENTS}/ and all flow files to ${STAGING_FLOWS}/ (these are staging directories).`;
    const task = replanNotes
      ? `${desc}\n\nReplan notes: ${replanNotes}${stagingInstructions}`
      : `${desc}${stagingInstructions}`;

    // Resolve architect model for display
    let architectResolvedModel = "";
    let architectModelAlias = architectConfig.model || "";
    try {
      const { modelId } = resolveModel(pi, architectConfig.model, architectConfig.thinking);
      architectResolvedModel = modelId;
    } catch { /* model resolution may fail — non-fatal for display */ }

    // Emit architect-started (for each iteration)
    pi.events.emit("flow:architect-started", {
      mode: "new",
      description: desc,
      iteration,
      resolvedModel: architectResolvedModel,
      modelAlias: architectModelAlias,
    });

    architectAbort = new AbortController();

    // Listen for abort events
    const unsubAbort = pi.events.on("flow:architect-abort", () => {
      architectAbort?.abort();
    });

    const spawnCtx = getSpawnContext(pi);
    const result = await spawnAgent({
      agent: architectConfig,
      task,
      templateContext: { ...templateCtx, task },
      pi,
      cwd: projectRoot,
      authStorage: spawnCtx.authStorage,
      modelRegistry: spawnCtx.modelRegistry,
      extraAgentExtensions: spawnCtx.extraAgentExtensions,
      extraCustomTools: spawnCtx.tools,
      preambleSections: architectContext
        ? [
            `## Session Summary\n\nThe following is a structured summary of the user's main session that led to this flow request. Use it to understand what the user is trying to accomplish, what tools or patterns were discussed, and what they actually want the flow to do:\n\n${architectContext}`,
          ]
        : undefined,
      signal: architectAbort.signal,
      onToolCall: (toolName, input) => {
        pi.events.emit("flow:architect-tool-call", { toolName, input });
      },
      onToolResult: (toolName, output, isError) => {
        pi.events.emit("flow:architect-tool-result", { toolName, output, isError });
      },
      onAssistantText: (text) => {
        pi.events.emit("flow:architect-text", { kind: "assistant", text });
      },
      onThinkingText: (text) => {
        pi.events.emit("flow:architect-text", { kind: "thinking", text });
      },
    });

    unsubAbort();
    architectAbort = null;

    // If aborted, treat as cancel
    if (!result.success && result.result?.summary === "Aborted by user") {
      choice = "Cancel";
      pi.events.emit("flow:architect-cancelled", { phase: "abort" });
      break;
    }

    // Extract flow path and created files from tool calls
    flowPath = "";
    createdFiles.length = 0;

    for (const tc of result.toolCalls) {
      if (tc.toolName === "flow_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { flowPath = path; createdFiles.push(path); allCreatedFiles.add(path); }
      }
      if (tc.toolName === "agent_write" && !tc.isError) {
        const path = tc.input?.path;
        if (path) { createdFiles.push(path); allCreatedFiles.add(path); }
      }
    }

    if (!flowPath) {
      // Architect failed to produce a flow
      const summary = result.result?.summary || result.output?.slice(0, 500) || "No details available";
      pi.events.emit("flow:architect-error", { summary });

      const retryChoice = await emitPromptAndAwait(pi, {
        pipeline: "architect-new",
        type: "select",
        question: `Architect couldn't produce a flow:\n${summary}\n\nWhat would you like to do?`,
        options: ["Retry", "Cancel"],
      });
      if (retryChoice.cancelled || retryChoice.answer !== "Retry") {
        pi.events.emit("flow:architect-cancelled", { phase: "save-decision" });
        break;
      }
      const notesResult = await emitPromptAndAwait(pi, {
        pipeline: "architect-new",
        type: "input",
        question: "Additional guidance for the architect:",
      });
      if (notesResult.cancelled || !notesResult.answer) {
        choice = "Cancel";
        pi.events.emit("flow:architect-cancelled", { phase: "replan-notes" });
        break;
      }
      replanNotes = notesResult.answer;
      pi.events.emit("flow:architect-replan", { iteration: iteration + 1, notes: replanNotes });
      continue;
    }

    // Emit preview with flow contents
    const flowContents: Array<{ name: string; content: string }> = [];
    for (const f of createdFiles) {
      if (f.endsWith(".yaml") && existsSync(f)) {
        try {
          flowContents.push({ name: f, content: readFileSync(f, "utf-8") });
        } catch { /* ignore */ }
      }
    }
    const parsedFlows = flowContents.map(f => parseFlowForDashboard(f.content));
    pi.events.emit("flow:architect-preview", { flows: flowContents, parsedFlows, flowPath, createdFiles });

    // Step 1: Save decision
    choice = await emitPromptAndAwait(pi, {
      pipeline: "architect-new",
      type: "select",
      question: "Save this flow?",
      options: ["Save", "Don't save", "Replan"],
    }).then(r => r.cancelled ? "Cancel" : (r.answer || "Cancel"));

    if (choice === "Replan") {
      const notesResult = await emitPromptAndAwait(pi, {
        pipeline: "architect-new",
        type: "input",
        question: "What should be changed?",
      });
      if (notesResult.cancelled || !notesResult.answer) {
        choice = "Cancel";
        pi.events.emit("flow:architect-cancelled", { phase: "replan-notes" });
        break;
      }
      replanNotes = notesResult.answer;
      // Wipe staging and recreate for fresh iteration
      wipeStagingDir(projectRoot);
      createStagingDir(projectRoot);
      createdFiles.length = 0;
      flowPath = "";
      pi.events.emit("flow:architect-replan", { iteration: iteration + 1, notes: replanNotes });
      continue;
    }

    break; // Save, Don't save, or Cancel
  }

  if (choice === "Cancel") {
    wipeStagingDir(projectRoot);
    // Only emit cancelled if we haven't already emitted it in the loop
    pi.events.emit("flow:architect-complete", { choice: "cancel" });
    architectRunning = false;
    return;
  }

  if (!flowPath) {
    // Architect failed — error diagnostic already shown
    pi.events.emit("flow:architect-complete", { choice: "error" });
    architectRunning = false;
    return;
  }

  // Step 5: Handle save decision
  let safeName = "";
  let didSave = false;

  if (choice === "Save") {
    const defaultName = slugify(desc);
    const nameResult = await emitPromptAndAwait(pi, {
      pipeline: "architect-new",
      type: "input",
      question: "Name this flow (available as /custom:<name>):",
      defaultValue: defaultName,
    });

    if (nameResult.answer) {
      safeName = slugify(nameResult.answer);
      const finalFlowPath = promoteStagingToFinal(projectRoot, safeName);
      flowPath = finalFlowPath || flowPath;

      // Re-discover so the saved flow registers as a command immediately
      pi.events.emit("flow:rediscover", {});

      pi.events.emit("flow:architect-saved", {
        flowName: safeName,
        flowPath,
        commandName: `custom:${safeName}`,
        mode: "new",
      });
      didSave = true;
    } else {
      // User cancelled naming — treat as "Don't save"
      choice = "Don't save";
    }
  }

  // Step 2: Run decision
  const runChoice = await emitPromptAndAwait(pi, {
    pipeline: "architect-new",
    type: "select",
    question: "Run now?",
    options: ["Yes", "No"],
  }).then(r => r.cancelled ? "No" : (r.answer || "No"));

  if (runChoice === "No") {
    // No run — clean up staging if we didn't save
    if (!didSave) {
      wipeStagingDir(projectRoot);
    }
    pi.events.emit("flow:architect-complete", {
      choice: didSave ? "save" : "cancel",
      flowName: didSave ? safeName : undefined,
      flowPath: didSave ? flowPath : undefined,
    });
    architectRunning = false;
    return;
  }

  // Step 6: Execute the designed flow via the flow manager (proper lifecycle)
  try {
    // Re-discover to pick up custom agents written by architect
    pi.events.emit("flow:rediscover", {});

    const { parseFlowYamlFile } = await import("../flow-engine/flow-parser-yaml.js");
    const flowConfig = parseFlowYamlFile(flowPath);

    let runFlowName: string;

    if (didSave) {
      // After promotion the flow lives at custom/<safeName>.yaml.
      // Discovery derives the name as "custom:<safeName>" — that is the Map key.
      // flowConfig.name is the frontmatter name and does NOT match the Map key,
      // so we must use the filesystem-derived name here.
      runFlowName = `custom:${safeName}`;
      runningFromStaging = false;
    } else {
      // "Don't save" + run: flow is still in the flat staging dir.
      // Register staging flows dir temporarily so the flow can be discovered.
      pi.events.emit("flow:register-flows-dir", { dir: join(projectRoot, STAGING_FLOWS) });
      // Re-discover again to pick up the staged flow
      pi.events.emit("flow:rediscover", {});
      runFlowName = flowConfig.name;
      runningFromStaging = true;
    }

    pi.events.emit("flow:architect-run-handoff", { flowName: runFlowName, saved: didSave });

    // Run via flow:run event — uses flowManager with proper dashboard, callbacks, cleanup
    pi.events.emit("flow:run", { flowName: runFlowName });
  } catch (err: any) {
    pi.events.emit("flow:architect-error", { phase: "run", error: err.message });
  }

  pi.events.emit("flow:architect-complete", {
    choice: "run",
    flowName: didSave ? safeName : undefined,
    flowPath,
  });
  architectRunning = false;
}

// ---- Extension activation -------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const projectRoot = process.cwd();

  // No lastCtx — all interactions go through events.

  // Listen for abort events to forward to the running architect
  pi.events.on("flow:architect-abort", () => {
    architectAbort?.abort();
  });

  // flows:new-request — triggered by /flows:new or /flows → "New flow"
  pi.events.on("flows:new-request", async (data: any) => {
    if (architectRunning) {
      // TUI-only error: dashboard reducer guard drops architect_error before state exists.
      pi.events.emit("flow:architect-init-error", { reason: "already-running" });
      return;
    }
    architectRunning = true;
    const description = (data as any)?.description || "";
    try {
      await handleNewFlow(pi, projectRoot, description);
    } finally {
      architectRunning = false;
    }
  });

  // flows:edit-request — triggered by /flows:edit or /flows <name> → Edit
  pi.events.on("flows:edit-request", async (data: any) => {
    if (architectRunning) {
      // TUI-only error: dashboard reducer guard drops architect_error before state exists.
      pi.events.emit("flow:architect-init-error", { reason: "already-running" });
      return;
    }
    architectRunning = true;
    const { flowName, flowPath, modificationRequest } = data as { flowName: string; flowPath: string; modificationRequest?: string };
    if (flowPath && !existsSync(flowPath)) {
      // TUI-only error: dashboard reducer guard drops architect_error before state exists.
      pi.events.emit("flow:architect-init-error", { reason: "agent-not-found" });
      architectRunning = false;
      return;
    }
    try {
      await handleEditFlow(pi, projectRoot, flowName, flowPath, modificationRequest);
    } finally {
      architectRunning = false;
    }
  });

  // Clean up staging after a non-saved flow run completes (success, error, or abort)
  pi.events.on("flow:complete", () => {
    if (!runningFromStaging) return;
    runningFromStaging = false;
    wipeStagingDir(projectRoot);
    pi.events.emit("flow:unregister-flows-dir", { dir: join(projectRoot, STAGING_FLOWS) });
    pi.events.emit("flow:unregister-agents-dir", { dir: join(projectRoot, STAGING_AGENTS) });
  });
}
