import type { AgentConfig, AgentResult, ParsedResult, TemplateContext, ToolCallRecord } from "./types.js";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createExtensionRuntime,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { resolveModel } from "./model-roles.js";
import { parseResult } from "./result-parser.js";
import type { GuardOptions } from "./guard.js";
import { createGuardExtension } from "./guard.js";
import { prefixToolName } from "./tool-prefix.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export { prefixToolName } from "./tool-prefix.js";

/**
 * Decide how a spawned agent's session should be created.
 * Pure — no SDK calls — so the fork/in-memory decision is unit-testable.
 *
 * - fork_session off            → in-memory (default behavior)
 * - fork_session on + main file → fork the operator's persisted session
 * - fork_session on + no file   → in-memory fallback (main session not persisted)
 */
export function planAgentSession(
  forkSession: boolean | undefined,
  mainSessionFile: string | undefined,
): { mode: "fork"; file: string } | { mode: "in-memory"; reason?: string } {
  if (!forkSession) return { mode: "in-memory" };
  if (mainSessionFile) return { mode: "fork", file: mainSessionFile };
  return { mode: "in-memory", reason: "main session not persisted to disk" };
}

/**
 * Read declared context files relative to `cwd`, returning preamble sections
 * for found files and the paths that were missing or unreadable. Pure I/O —
 * no prompt assembly — so injection is unit-testable.
 */
export function loadContextFiles(
  cwd: string,
  files: string[] | undefined,
): { sections: string[]; missing: string[]; unreadable: string[] } {
  const sections: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  for (const file of files ?? []) {
    const absPath = pathResolve(cwd, file);
    if (!existsSync(absPath)) {
      missing.push(file);
      continue;
    }
    try {
      sections.push(`## Context: ${file}\n\n${readFileSync(absPath, "utf-8")}`);
    } catch {
      unreadable.push(file);
    }
  }
  return { sections, missing, unreadable };
}

/**
 * Replace sentinel placeholders with actual file content.
 * Sentinels are unique strings like `__FILE_INPUT_name_timestamp__` that were inserted
 * during input resolution so that expandTemplateVariables would not parse the file content
 * (which may contain ${{}} syntax).
 */
function replaceSentinels(text: string, sentinelMap: Record<string, string>): string {
  for (const [sentinel, content] of Object.entries(sentinelMap)) {
    text = text.replaceAll(sentinel, content);
  }
  return text;
}

// Template variable expansion
export function expandTemplateVariables(template: string, ctx: TemplateContext): string {
  return template
    // Primary syntax: ${{...}}
    .replace(/\$\{\{task\}\}/g, ctx.task)
    .replace(/\$\{\{input\.([\w-]+)\}\}/g, (_, name) => ctx.inputs[name] ?? "")
    .replace(/\$\{\{result\.([\w-]+)\.status\}\}/g, (_, id) => ctx.results[id]?.status ?? "")
    .replace(/\$\{\{result\.([\w-]+)\.summary\}\}/g, (_, id) => ctx.results[id]?.summary ?? "")
    .replace(/\$\{\{result\.([\w-]+)\.artifacts\}\}/g, (_, id) => ctx.results[id]?.artifacts ?? "")
    .replace(/\$\{\{result\.([\w-]+)\.files\}\}/g, (_, id) => ctx.results[id]?.files ?? "")
    // Catch-all for typed outputs: ${{result.STEP.anyField}}
    .replace(/\$\{\{result\.([\w-]+)\.([\w]+)\}\}/g, (_, id, field) => ctx.results[id]?.[field] ?? "")
    .replace(/\$\{\{result\.([\w-]+)\}\}/g, (_, id) => ctx.results[id]?.fullOutput ?? "")
    .replace(/\$\{\{loop\.([\w-]+)\.iteration\}\}/g, (_, id) => String(ctx.loopCounters?.[id] ?? 0))
    .replace(/\$\{\{loop\.([\w-]+)\.max\}\}/g, (_, id) => String(ctx.loopMaxIterations?.[id] ?? 0));
}

// Tool factory map: agent tool name -> SDK tool factory
const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

export interface SpawnOptions {
  agent: AgentConfig;
  task: string;
  templateContext: TemplateContext;
  skillContents?: Map<string, string>;
  preambleSections?: string[];
  /** File inputs (file:// resolved) — injected AFTER template expansion to prevent content from being parsed */
  fileInputs?: Record<string, string>;
  /** Extension API handle — used by `resolveModel` to emit `model:resolve`
   *  and fall back to `pi.modelRegistry`. */
  pi: ExtensionAPI;
  cwd: string;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  /** Operator's live SessionManager. When the agent declares `fork_session`,
   *  its persisted file is forked via SessionManager.forkFrom for context inheritance. */
  mainSessionManager?: SessionManager;
  extraAgentExtensions?: ExtensionFactory[];
  extraCustomTools?: any[];  // ToolDefinition[] — extension tools to include in the session
  onToolCall?: (toolName: string, input: any) => void;
  onToolResult?: (toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (text: string) => void;
  onThinkingText?: (text: string) => void;
  onExtensionUIRequest?: (request: any, respond: (response: any) => void) => void;
  decisionBranches?: string[];
  signal?: AbortSignal;
  /** Pre-resolved model ID — when provided, skips resolveModel() call. */
  resolvedModelId?: string;
}

/**
 * Build an Extension object from a factory function.
 *
 * Replaces loadExtensionFromFactory which is not exported from the top-level
 * pi-coding-agent package (blocked by exports map). Creates a minimal
 * ExtensionAPI that records handlers and tools into an Extension-shaped
 * object, which the ExtensionRunner will later bind with real actions.
 */
async function buildExtensionFromFactory(factory: ExtensionFactory, runtime: any, toolPrefix: string = ""): Promise<any> {
  const handlers = new Map<string, any[]>();
  const tools = new Map<string, any>();

  // Minimal ExtensionAPI — only needs to record registrations.
  // Action methods (sendMessage, sendUserMessage, etc.) delegate to runtime
  // which gets wired by ExtensionRunner._bindExtensionCore at build time.
  const api: any = {
    on: (event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool: (tool: any) => {
      const name = prefixToolName(tool.name, toolPrefix);
      const prefixedTool = name !== tool.name ? { ...tool, name } : tool;
      tools.set(name, { definition: prefixedTool, extensionPath: "<guard>" });
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerProvider: (...args: any[]) => runtime.registerProvider?.(...args),
    unregisterProvider: (...args: any[]) => runtime.unregisterProvider?.(...args),
    // Action methods — delegate to runtime (stubs replaced at bind time)
    sendMessage: (...args: any[]) => runtime.sendMessage(...args),
    sendUserMessage: (...args: any[]) => runtime.sendUserMessage(...args),
    appendEntry: (...args: any[]) => runtime.appendEntry(...args),
    setSessionName: (...args: any[]) => runtime.setSessionName(...args),
    getSessionName: () => runtime.getSessionName(),
    setLabel: (...args: any[]) => runtime.setLabel(...args),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    getActiveTools: () => runtime.getActiveTools(),
    getAllTools: () => runtime.getAllTools(),
    setActiveTools: (...args: any[]) => runtime.setActiveTools(...args),
    getCommands: () => runtime.getCommands(),
    setModel: async () => false,
    getThinkingLevel: () => runtime.getThinkingLevel(),
    setThinkingLevel: (...args: any[]) => runtime.setThinkingLevel(...args),
    events: createEventBus(),
  };

  // Run the factory — it calls api.on() and api.registerTool().
  // MUST await: see the doc comment above. Async factories (e.g. the
  // pi-anthropic-messages adapter that dynamic-imports the package before
  // registering hooks) will otherwise return a pending Promise and leave
  // `handlers` empty.
  await factory(api);

  // Return Extension-shaped object
  return {
    path: "<guard>",
    resolvedPath: "<guard>",
    handlers,
    tools,
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

export async function spawnAgent(options: SpawnOptions): Promise<AgentResult> {
  const { agent, task, templateContext, pi, cwd } = options;
  const startTime = Date.now();
  const toolCalls: ToolCallRecord[] = [];

  // Check if already aborted before creating session
  if (options.signal?.aborted) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      output: "Aborted by user",
      stderr: "",
      exitCode: null,
      result: { status: "error" as const, summary: "Aborted by user", files: [], artifacts: "" },
      toolCalls,
      duration,
      tokens: { input: 0, output: 0 },
    };
  }

  // Resolve model (skip if pre-resolved)
  const { modelId, thinking } = options.resolvedModelId
    ? { modelId: options.resolvedModelId, thinking: agent.thinking }
    : resolveModel(pi, agent.model, agent.thinking);

  // Build system prompt: expand template variables in agent body
  let systemPrompt = expandTemplateVariables(agent.systemPrompt, templateContext);

  // Inject skill contents
  if (options.skillContents) {
    for (const [name, content] of options.skillContents) {
      systemPrompt = `## Skill: ${name}\n\n${content}\n\n` + systemPrompt;
    }
  }

  // Inject context file contents
  if (options.preambleSections?.length) {
    const preamble = options.preambleSections.join("\n\n---\n\n");
    systemPrompt = `## Context\n\n${preamble}\n\n` + systemPrompt;
  }

  // Replace file input sentinels with actual content AFTER template expansion
  if (options.fileInputs) {
    systemPrompt = replaceSentinels(systemPrompt, options.fileInputs);
  }

  // Resolve Model object from modelId
  // modelId may be "provider/model-id" or just "model-id"
  let model: any;
  try {
    if (options.modelRegistry) {
      const parts = modelId.split("/");
      if (parts.length >= 2) {
        // Explicit provider/model format
        model = options.modelRegistry.find(parts[0], parts.slice(1).join("/"));
      }
      if (!model) {
        // Search all models in registry by model ID
        const allModels = options.modelRegistry.getAll?.() ?? [];
        model = allModels.find((m: any) => m.id === modelId);
      }
    }
    if (!model) {
      // Fallback: try getModel from pi-ai for well-known providers
      const parts = modelId.split("/");
      if (parts.length >= 2) {
        model = getModel(parts[0] as any, parts.slice(1).join("/") as any);
      }
    }
  } catch {
    // Model resolution failed — will be caught below
  }

  if (!model) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      output: `Failed to resolve model: ${modelId}`,
      stderr: `Model "${modelId}" not found in registry`,
      exitCode: null,
      result: { status: "error" as const, summary: `Failed to resolve model: ${modelId}`, files: [], artifacts: "" },
      toolCalls,
      duration,
      tokens: { input: 0, output: 0 },
    };
  }

  // Resolve authStorage — from explicit option or from modelRegistry
  const authStorage = options.authStorage
    ?? (options.modelRegistry as any)?.authStorage
    ?? undefined;

  // Detect Anthropic-messages protocol: any provider using anthropic-messages
  // needs non-core tools registered with mcp__flows__ prefix so Anthropic's
  // endpoint accepts them. This covers direct OAuth, API key, AND proxy
  // providers (e.g., 9Router) that forward to Anthropic. The mcp__ prefix
  // is harmless for all anthropic-messages endpoints.
  let toolPrefix = "";
  if (model.api === "anthropic-messages") {
    toolPrefix = "mcp__flows__";
  }

  // Built-in pi tools (read/write/grep/find/bash/edit/ls) the agent declares.
  // pi-coding-agent's createAgentSession({ tools }) accepts a STRING ARRAY of
  // tool NAMES that select subsets of its built-in tool registry. Passing tool
  // definition objects (the previous behaviour) silently failed: the SDK's
  // `allowedToolNames` set was filled with `[object Object]` entries that
  // never match real tool names, so EVERY tool got filtered out and the
  // outbound payload contained no `tools` array. The architect subagent then
  // saw "Available tools: (none)" and refused to call any tool.
  //
  // pi's SDK looks tools up by their canonical lowercase name ("read",
  // "bash", "grep", "find", "ls", "edit", "write"). Outbound canonical
  // capitalization or mcp__ prefixing for Claude-model anthropic-messages
  // sessions happens later in pi-ai or @pi/anthropic-messages — we MUST pass
  // the lowercase pi-internal names here.
  const builtinToolNames = agent.tools.filter(t => TOOL_FACTORIES[t]);

  // Custom tools (agent_catalog, agent_write, flow_write, finish, ask_user, …)
  // are passed as full ToolDefinition objects via `customTools`. The SDK adds
  // them to its tool registry. For anthropic-messages sessions they need the
  // mcp__flows__ prefix on their wire name so Claude's endpoint accepts them.
  const customTools = (options.extraCustomTools ?? []).map((t: any) => {
    const prefixed = prefixToolName(t.name, toolPrefix);
    return prefixed !== t.name ? { ...t, name: prefixed } : t;
  });

  // Build guard options
  const guardOptions: GuardOptions = {
    allowedTools: [...agent.tools, "finish"],
    requireFinish: true,
    accessRules: agent.access,
    decisionBranches: options.decisionBranches,
    agentOutputs: agent.outputs,
    allowAskUser: !!options.onExtensionUIRequest,
    toolPrefix,
  };

  // Build extension factories array
  const extensionFactories: ExtensionFactory[] = [
    createGuardExtension(guardOptions),
    ...(options.extraAgentExtensions ?? []),
  ];

  // Build Extension objects from factories.
  // We construct them manually because loadExtensionFromFactory is not
  // exported from the top-level pi-coding-agent package (ERR_PACKAGE_PATH_NOT_EXPORTED).
  const runtime = createExtensionRuntime();
  const extensions: any[] = [];
  for (const factory of extensionFactories) {
    try {
      // MUST await — see buildExtensionFromFactory doc comment. Async
      // factories (pi-anthropic-messages adapter, etc.) register hooks
      // only after their internal awaits resolve.
      const ext = await buildExtensionFromFactory(factory, runtime, toolPrefix);
      extensions.push(ext);
    } catch {
      // Skip failed extensions
    }
  }


  // Use getAppendSystemPrompt (NOT getSystemPrompt) so the SDK builds
  // the full default system prompt WITH tool descriptions and guidelines,
  // then appends our agent-specific prompt. If we used getSystemPrompt,
  // the SDK treats it as a complete custom prompt and skips tool descriptions.
  const capturedSystemPrompt = systemPrompt;
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions,
      errors: [],
      runtime,
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => capturedSystemPrompt ? [capturedSystemPrompt] : [],
    extendResources: () => {},
    reload: async () => {},
  };

  // Create subagent UI context — bridges select/confirm/input to the parent
  // session's AskUserQueue via the onExtensionUIRequest callback.
  const uiContext = createSubagentUIContext(agent.name, options.onExtensionUIRequest);

  // Create agent session.
  //
  // IMPORTANT: we pass `tools: undefined` (NOT a filtered name list) so
  // pi-coding-agent's `allowedToolNames` is undefined and the SDK does NOT
  // filter out our `customTools` or extension-registered tools (the guard's
  // `mcp__flows__finish`, the architect's `mcp__flows__agent_catalog`, etc.).
  //
  // The agent's tool sandbox is enforced by the guard extension (which blocks
  // tool_call events for unauthorized names) — not by the SDK's name allowlist.
  // We then call setActiveToolsByName below to tell the agent which tools to
  // expose in its system prompt and on the wire.
  // Session manager: fork the operator's persisted session when the agent
  // opts in via `fork_session`, otherwise a fresh in-memory session. A fork
  // requires the main session to be persisted to disk (getSessionFile()); if
  // it isn't, fall back to in-memory (current behavior).
  const sessionPlan = planAgentSession(
    agent.fork_session,
    options.mainSessionManager?.getSessionFile?.(),
  );
  let agentSessionManager: SessionManager;
  if (sessionPlan.mode === "fork") {
    try {
      agentSessionManager = SessionManager.forkFrom(sessionPlan.file, cwd);
    } catch (err: any) {
      console.warn(
        `[pi-flows] fork_session: forkFrom failed for "${agent.name}" (${err?.message}); ` +
        "falling back to in-memory session.",
      );
      agentSessionManager = SessionManager.inMemory();
    }
  } else {
    if (agent.fork_session) {
      console.warn(
        `[pi-flows] fork_session set on "${agent.name}" but ${sessionPlan.reason}; ` +
        "falling back to in-memory session.",
      );
    }
    agentSessionManager = SessionManager.inMemory();
  }

  let session: any;
  try {
    const { session: sess } = await createAgentSession({
      model,
      thinkingLevel: thinking as any,
      tools: undefined,                  // see comment above
      customTools: customTools,
      resourceLoader,
      sessionManager: agentSessionManager,
      authStorage,
      modelRegistry: options.modelRegistry,
      cwd,
    });
    session = sess;
  } catch (err: any) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      output: `Failed to create agent session: ${err.message}`,
      stderr: err.message,
      exitCode: null,
      result: { status: "error" as const, summary: `Session creation failed: ${err.message}`, files: [], artifacts: "" },
      toolCalls,
      duration,
      tokens: { input: 0, output: 0 },
    };
  }

  // Bind extensions with UI context
  await session.bindExtensions({ uiContext });

  // Activate the tools the agent should see on the wire. This MUST happen
  // after bindExtensions because that's when the guard extension registers
  // its `finish` tool into the session's tool registry. Calling
  // setActiveToolsByName here:
  //   - Picks the prefixed built-in names (read/grep/find — or Read/Grep/Find
  //     once pi-ai canonicalizes them outbound).
  //   - Adds prefixed customTools (mcp__flows__agent_catalog, mcp__flows__flow_write, …).
  //   - Adds the guard's prefixed finish tool (mcp__flows__finish).
  // The system prompt + outbound `tools` array are rebuilt accordingly.
  const activeToolNames = [
    ...builtinToolNames.map(name => prefixToolName(name, toolPrefix)),
    ...customTools.map((t: any) => t.name),
    prefixToolName("finish", toolPrefix),
  ];
  try {
    session.setActiveToolsByName(activeToolNames);
  } catch {
    // setActiveToolsByName is best-effort — even if it fails the tool
    // registry still contains the tools; only the system-prompt `Available
    // tools:` listing might lag.
  }

  // Wire event capture
  const finishToolName = prefixToolName("finish", toolPrefix);
  let finishParams: any = undefined;
  let finishToolCallId: string | undefined;
  let finishValidationRetries = 0;
  let lastAssistantText = "";
  let lastApiError: string | undefined;
  let accumulatedTokens = { input: 0, output: 0 };

  session.subscribe((event: any) => {
    switch (event.type) {
      case "tool_execution_start": {
        if (event.toolName === finishToolName) {
          finishParams = event.args;
          finishToolCallId = event.toolCallId;
        }
        const tc: ToolCallRecord = {
          toolName: event.toolName,
          input: event.args,
          output: "",
          duration: 0,
          isError: false,
        };
        toolCalls.push(tc);
        options.onToolCall?.(event.toolName, event.args);
        break;
      }
      case "tool_execution_end": {
        const rawResult = event.result;
        let output: any = rawResult;
        if (rawResult?.content?.[0]?.text) {
          try { output = JSON.parse(rawResult.content[0].text); } catch { output = rawResult.content[0].text; }
        }
        const last = toolCalls[toolCalls.length - 1];
        if (last) {
          last.output = output ?? "";
          last.isError = !!event.isError;
        }
        options.onToolResult?.(event.toolName || last?.toolName || "", output, !!event.isError);

        // Handle finish tool completion
        if (finishToolCallId && event.toolCallId === finishToolCallId) {
          if (event.isError) {
            // Finish validation failed — clear state so agent can retry
            finishParams = undefined;
            finishToolCallId = undefined;

            // Queue a followUp to force the agent to retry with valid args
            if (finishValidationRetries < MAX_FINISH_RETRIES) {
              finishValidationRetries++;
              session.followUp(
                `Your \`${finishToolName}\` tool call failed schema validation. ` +
                `Review the validation error above and call \`${finishToolName}\` again with all required fields. ` +
                "Make sure to include every required parameter."
              );
            }
          } else {
            // Abort session immediately after finish tool completes — no more LLM turns needed
            session.abort();
          }
        }
        break;
      }
      case "message_end": {
        if (event.message?.role === "assistant") {
          // Detect API errors
          if (event.message.stopReason === "error" && event.message.errorMessage) {
            lastApiError = event.message.errorMessage;
          }
          // Accumulate token usage
          const msgUsage = event.message.usage;
          if (msgUsage) {
            accumulatedTokens.input += msgUsage.input || 0;
            accumulatedTokens.output += msgUsage.output || 0;
          }
          // Extract text and thinking blocks
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                lastAssistantText = block.text;
                options.onAssistantText?.(block.text);
              } else if (block.type === "thinking" && block.thinking && !block.redacted) {
                options.onThinkingText?.(block.thinking);
              }
            }
          }
        }
        break;
      }
    }
  });

  // Wire abort signal
  const onAbort = () => { session.abort(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // Build user message
  let userMessage = `Task: ${expandTemplateVariables(task, templateContext)}`;

  // Replace file input sentinels in user message AFTER template expansion
  if (options.fileInputs) {
    userMessage = replaceSentinels(userMessage, options.fileInputs);
  }

  // Execute prompt with finish-retry loop.
  // The guard's agent_end → followUp retry doesn't work in-process because
  // Agent.emit() doesn't await async listeners. So we retry here explicitly.
  const MAX_FINISH_RETRIES = 2;
  let finishRetries = 0;

  try {
    await session.prompt(userMessage, { expandPromptTemplates: false });

    // Retry if agent didn't call finish
    while (!finishParams && finishRetries < MAX_FINISH_RETRIES && !options.signal?.aborted) {
      finishRetries++;
      await session.prompt(
        `You did not call the \`${finishToolName}\` tool. You MUST call \`${finishToolName}\` to submit your result.\n\n` +
        "Call it now with:\n" +
        "- status: \"complete\", \"error\", or \"blocked\"\n" +
        "- summary: brief description of what you did\n" +
        "- files: array of { path, action } for files you touched\n" +
        "- artifacts: (optional) any structured data",
        { expandPromptTemplates: false }
      );
    }
  } catch (err: any) {
    // prompt() may throw on catastrophic errors
    if (!lastApiError) lastApiError = err.message;
  }

  // Cleanup abort listener
  options.signal?.removeEventListener("abort", onAbort);

  const duration = Date.now() - startTime;
  const aborted = options.signal?.aborted;

  // Handle user-initiated abort (Ctrl+X / external signal).
  // Skip this path if finish was called — the session was aborted intentionally
  // after finish completed, and finishParams holds the real result.
  if (aborted && !finishParams) {
    return {
      success: false,
      output: lastAssistantText || "Aborted by user",
      stderr: "",
      exitCode: null,
      result: { status: "error" as const, summary: "Aborted by user", files: [], artifacts: "" },
      toolCalls,
      duration,
      tokens: { ...accumulatedTokens },
    };
  }

  // Handle API errors with no useful output
  if (lastApiError && !finishParams && toolCalls.length === 0) {
    let errorMsg = lastApiError;
    try {
      const match = lastApiError.match(/^\d+\s+(.*)/);
      if (match) {
        const body = JSON.parse(match[1]);
        errorMsg = `API error: ${body.error?.message || lastApiError}`;
      }
    } catch { /* use raw error string */ }

    return {
      success: false,
      output: errorMsg,
      stderr: lastApiError,
      exitCode: null,
      result: { status: "error", summary: errorMsg, files: [], artifacts: "" },
      toolCalls: [],
      duration,
      tokens: { ...accumulatedTokens },
    };
  }

  // Build AgentResult from accumulated data
  const parsed = finishParams
    ? {
        status: finishParams.status as ParsedResult["status"],
        summary: finishParams.summary ?? "",
        files: Array.isArray(finishParams.files)
          ? finishParams.files.map((f: any) => ({ path: f.path, action: f.action }))
          : [],
        artifacts: finishParams.artifacts ?? "",
      }
    : parseResult(lastAssistantText);

  // Extract typed outputs from finishParams based on agent's declared outputs
  const typedOutputs: Record<string, string> = {};
  if (finishParams && agent.outputs) {
    for (const output of agent.outputs) {
      if (finishParams[output.name] !== undefined) {
        typedOutputs[output.name] = String(finishParams[output.name]);
      }
    }
  }

  return {
    success: parsed.status === "complete",
    output: lastAssistantText,
    stderr: "",
    exitCode: null,
    result: parsed,
    toolCalls,
    duration,
    tokens: { ...accumulatedTokens },
    finishParams: finishParams ?? undefined,
    typedOutputs: Object.keys(typedOutputs).length > 0 ? typedOutputs : undefined,
  };
}

/**
 * Create an ExtensionUIContext for subagent sessions that bridges
 * select/confirm/input calls to the parent session's AskUserQueue
 * via the onExtensionUIRequest callback.
 *
 * This enables subagent extensions (e.g., ask_user tool) to show
 * UI prompts in the parent session's TUI. Non-interactive methods
 * are no-ops since subagents don't own any TUI surface.
 */
function createSubagentUIContext(
  agentName: string,
  onExtensionUIRequest?: (request: any, respond: (response: any) => void) => void,
): ExtensionUIContext {
  const bridgeRequest = (method: string, args: any): Promise<any> => {
    if (!onExtensionUIRequest) {
      if (method === "confirm") return Promise.resolve(false);
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const id = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      onExtensionUIRequest(
        { id, method, ...args },
        (response: any) => {
          if (response.cancelled) {
            resolve(method === "confirm" ? false : undefined);
          } else if (method === "confirm") {
            resolve(!!response.confirmed);
          } else {
            resolve(response.value);
          }
        },
      );
    });
  };

  return {
    select: (title, selectOptions, _opts) =>
      bridgeRequest("select", { title, options: selectOptions }) as Promise<string | undefined>,
    confirm: (title, message, _opts) =>
      bridgeRequest("confirm", { title, message }) as Promise<boolean>,
    input: (title, placeholder, _opts) =>
      bridgeRequest("input", { title, placeholder }) as Promise<string | undefined>,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    addAutocompleteProvider: () => {},
    getEditorComponent: () => undefined,
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: () => Promise.resolve(undefined as any),
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: () => Promise.resolve(undefined),
    setEditorComponent: () => {},
    get theme(): any { return {}; },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
