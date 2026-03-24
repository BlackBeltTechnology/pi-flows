import type { AgentConfig, AgentResult, ParsedResult, TemplateContext, ToolCallRecord } from "./types.js";
import { resolveModel } from "./model-roles.js";
import { parseResult } from "./result-parser.js";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Template variable expansion
export function expandTemplateVariables(template: string, ctx: TemplateContext): string {
  return template
    .replace(/\{task\}/g, ctx.task)
    .replace(/\{input\.([\w-]+)\}/g, (_, name) => ctx.inputs[name] ?? "")
    .replace(/\{fork\.(\w[\w-]*)\.answer\}/g, (_, id) => ctx.forks[id]?.answer ?? "")
    .replace(/\{fork\.(\w[\w-]*)\.notes\}/g, (_, id) => ctx.forks[id]?.notes ?? "")
    .replace(/\{result\.([\w-]+)\.status\}/g, (_, id) => ctx.results[id]?.status ?? "")
    .replace(/\{result\.([\w-]+)\.summary\}/g, (_, id) => ctx.results[id]?.summary ?? "")
    .replace(/\{result\.([\w-]+)\.artifacts\}/g, (_, id) => ctx.results[id]?.artifacts ?? "")
    .replace(/\{result\.([\w-]+)\.files\}/g, (_, id) => ctx.results[id]?.files ?? "")
    .replace(/\{result\.([\w-]+)\}/g, (_, id) => ctx.results[id]?.fullOutput ?? "")
    .replace(/\{loop\.([\w-]+)\.iteration\}/g, (_, id) => String(ctx.loopCounters?.[id] ?? 0))
    .replace(/\{loop\.([\w-]+)\.max\}/g, (_, id) => String(ctx.loopMaxIterations?.[id] ?? 0));
}

export interface SpawnOptions {
  agent: AgentConfig;
  task: string;
  templateContext: TemplateContext;
  skillContents?: Map<string, string>;   // skill name -> SKILL.md content
  contextFileContents?: string[];        // context file contents to inject
  getModelRole?: (role: string) => string | undefined;
  cwd: string;
  guardExtPath: string;                  // path to guard.ts extension
  onToolCall?: (toolName: string, input: any) => void;
  onToolResult?: (toolName: string, output: any, isError: boolean) => void;
  onAssistantText?: (text: string) => void;
  onThinkingText?: (text: string) => void;
  decisionBranches?: string[];           // valid branch names for decision steps
  allowSubagent?: boolean;               // allow subagent tool (for flow architect)
  signal?: AbortSignal;                  // abort signal to cancel the agent
}

export async function spawnAgent(options: SpawnOptions): Promise<AgentResult> {
  const { agent, task, templateContext, getModelRole, cwd, guardExtPath } = options;
  const startTime = Date.now();
  const toolCalls: ToolCallRecord[] = [];

  // Resolve model
  const { modelId, thinking } = resolveModel(agent.model, agent.thinking, getModelRole);

  // Build system prompt: expand template variables in agent body
  let systemPrompt = expandTemplateVariables(agent.systemPrompt, templateContext);

  // Inject skill contents
  if (options.skillContents) {
    for (const [name, content] of options.skillContents) {
      systemPrompt = `## Skill: ${name}\n\n${content}\n\n` + systemPrompt;
    }
  }

  // Inject context file contents
  if (options.contextFileContents?.length) {
    const contextSection = options.contextFileContents.join("\n\n---\n\n");
    systemPrompt = `## Context Files\n\n${contextSection}\n\n` + systemPrompt;
  }

  // Write system prompt to temp file
  const tmpDir = join(tmpdir(), "pi-flows");
  mkdirSync(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `prompt-${randomUUID()}.md`);
  writeFileSync(promptFile, systemPrompt, "utf-8");

  // Write access rules to temp file if present
  let accessRulesFile: string | undefined;
  if (agent.access) {
    accessRulesFile = join(tmpDir, `access-${randomUUID()}.json`);
    writeFileSync(accessRulesFile, JSON.stringify(agent.access), "utf-8");
  }

  // Build CLI args
  const args = ["--mode", "json", "-p"];
  args.push("--model", modelId);
  if (thinking) args.push("--thinking", thinking);
  // Only pass built-in tools via --tools (extension tools like agent_catalog,
  // flow_write are registered at runtime by extensions and available automatically).
  // Passing unknown names to --tools produces harmless warnings but we filter
  // them out for cleanliness.
  const builtInTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const cliTools = agent.tools.filter(t => builtInTools.has(t));
  if (cliTools.length > 0) args.push("--tools", cliTools.join(","));
  args.push("--append-system-prompt", promptFile);

  // Add guard extension
  args.push("--extension", guardExtPath);

  // Build user message (task)
  const userMessage = `Task: ${expandTemplateVariables(task, templateContext)}`;

  // Use @file syntax for large tasks
  let taskArg: string;
  if (userMessage.length > 8000) {
    const taskFile = join(tmpDir, `task-${randomUUID()}.md`);
    writeFileSync(taskFile, userMessage, "utf-8");
    taskArg = `@${taskFile}`;
  } else {
    taskArg = userMessage;
  }
  args.push(taskArg);

  // Spawn process
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (accessRulesFile) env.AGENT_ACCESS_RULES = accessRulesFile;
  env.AGENT_REQUIRE_FINISH = "1";
  if (options.decisionBranches) {
    env.AGENT_DECISION_BRANCHES = JSON.stringify(options.decisionBranches);
  }
  if (options.allowSubagent) {
    env.AGENT_ALLOW_SUBAGENT = "1";
  }

  // Pass declared tools to guard for whitelist enforcement
  const allowedTools = [...agent.tools, "finish"];
  env.AGENT_ALLOWED_TOOLS = JSON.stringify(allowedTools);

  // Check if already aborted before spawning
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

  return new Promise<AgentResult>((resolve) => {
    const proc = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // Wire abort signal to kill the process
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
      // SIGKILL fallback after 3 seconds
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 3000);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";
    let lineBuf = ""; // Buffer for incomplete JSONL lines split across chunks
    let finishParams: any = undefined; // Last finish tool call args (if any)
    let lastApiError: string | undefined; // Last API-level error (rate limit, auth, etc.)
    let accumulatedTokens = { input: 0, output: 0 }; // Accumulated from message_end events

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Parse JSONL events (with line buffering for chunk boundaries)
      const combined = lineBuf + text;
      const lines = combined.split("\n");
      lineBuf = lines.pop() ?? ""; // Last element may be incomplete — buffer it
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "tool_execution_start") {
            // Capture finish tool params for structured result extraction
            if (event.toolName === "finish") {
              finishParams = event.args;
            }
            // pi emits `args` (not `input`) for tool arguments
            const tc: ToolCallRecord = { toolName: event.toolName, input: event.args, output: "", duration: 0, isError: false };
            toolCalls.push(tc);
            options.onToolCall?.(event.toolName, event.args);
          } else if (event.type === "tool_execution_end") {
            // pi emits `result` (not `output`) — extract text from MCP content array
            const rawResult = event.result;
            let output: any = rawResult;
            if (rawResult?.content?.[0]?.text) {
              try { output = JSON.parse(rawResult.content[0].text); } catch { output = rawResult.content[0].text; }
            }
            const last = toolCalls[toolCalls.length - 1];
            if (last) { last.output = output ?? ""; last.isError = !!event.isError; }
            options.onToolResult?.(event.toolName || last?.toolName || "", output, !!event.isError);
          } else if (event.type === "message_end" && event.message?.role === "assistant") {
            // Detect API errors (rate limit, auth failures, etc.)
            if (event.message.stopReason === "error" && event.message.errorMessage) {
              lastApiError = event.message.errorMessage;
            }
            // Accumulate token usage from each assistant turn
            const msgUsage = event.message.usage;
            if (msgUsage) {
              accumulatedTokens.input += msgUsage.input || 0;
              accumulatedTokens.output += msgUsage.output || 0;
            }
            // Extract text and thinking blocks for detail view
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  options.onAssistantText?.(block.text);
                } else if (block.type === "thinking" && block.thinking && !block.redacted) {
                  options.onThinkingText?.(block.thinking);
                }
              }
            }
          }
        } catch { /* not JSON line */ }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      // Cleanup abort resources
      options.signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);

      // Cleanup temp files
      try { unlinkSync(promptFile); } catch { /* ignore */ }
      if (accessRulesFile) try { unlinkSync(accessRulesFile); } catch { /* ignore */ }

      const duration = Date.now() - startTime;

      // Handle aborted agent
      if (aborted) {
        resolve({
          success: false,
          output: stdout || "Aborted by user",
          stderr,
          exitCode: code,
          result: { status: "error" as const, summary: "Aborted by user", files: [], artifacts: "" },
          toolCalls,
          duration,
          tokens: { ...accumulatedTokens },
        });
        return;
      }

      // If the API returned errors (e.g. rate limit) and produced no useful output,
      // surface the error immediately instead of returning an empty "success".
      if (lastApiError && !finishParams && toolCalls.length === 0) {
        // Extract a human-readable message from the API error
        let errorMsg = lastApiError;
        try {
          const match = lastApiError.match(/^\d+\s+(.*)/);
          if (match) {
            const body = JSON.parse(match[1]);
            errorMsg = `API error: ${body.error?.message || lastApiError}`;
          }
        } catch { /* use raw error string */ }

        resolve({
          success: false,
          output: errorMsg,
          stderr: lastApiError,
          exitCode: code,
          result: { status: "error", summary: errorMsg, files: [], artifacts: "" },
          toolCalls: [],
          duration,
          tokens: { ...accumulatedTokens },
        });
        return;
      }

      // Extract final output from accumulated stdout
      const finalOutput = extractFinalOutput(stdout);

      // Prefer structured result from finish tool call; fall back to XML parsing
      const parsed = finishParams
        ? {
            status: finishParams.status as ParsedResult["status"],
            summary: finishParams.summary ?? "",
            files: Array.isArray(finishParams.files)
              ? finishParams.files.map((f: any) => ({ path: f.path, action: f.action }))
              : [],
            artifacts: finishParams.artifacts ?? "",
          }
        : parseResult(finalOutput);

      resolve({
        success: code === 0 && parsed.status !== "error",
        output: finalOutput,
        stderr,
        exitCode: code,
        result: parsed,
        toolCalls,
        duration,
        tokens: { ...accumulatedTokens },
        finishParams: finishParams ?? undefined,
      });
    });
  });
}

function extractFinalOutput(stdout: string): string {
  // Parse JSONL, find last assistant message_end with text content
  const lines = stdout.split("\n");
  let lastText = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const content = event.message.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (text) lastText = text;
        }
      }
    } catch { /* skip */ }
  }
  return lastText || stdout.slice(-5000);
}
