// ---------------------------------------------------------------------------
// Guard Extension -- Sandboxes spawned agent processes
//
// Injected into every spawned agent via --extension flag.
// Reads access rules from AGENT_ACCESS_RULES env var (path to temp JSON file).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";

interface AccessRules {
  read?: string[];
  write?: string[];
  bash?: { deny: string[] };
}

/**
 * Guard extension injected into spawned agent processes.
 * Loaded via --extension flag. Reads access rules from AGENT_ACCESS_RULES env (temp file path).
 *
 * File-type guards (e.g., .model blocking) are NOT hardcoded here — they are
 * registered by domain packages via flow:register-guard-extension and loaded
 * as separate --extension files alongside this guard.
 */
export default function guardExtension(pi: ExtensionAPI) {
  // Block ask_user unconditionally — subagents must never prompt the user
  pi.on("tool_call", (event: any) => {
    const toolName = event.toolName || event.name;
    if (toolName === "ask_user") {
      return {
        block: true,
        reason: "Subagents cannot use ask_user. Make a decision autonomously or report in your result.",
      };
    }
    return undefined;
  });

  // Block subagent tool by default — only flow architect (AGENT_ALLOW_SUBAGENT=1) can dispatch
  if (process.env.AGENT_ALLOW_SUBAGENT !== "1") {
    pi.on("tool_call", (event: any) => {
      const toolName = event.toolName || event.name;
      if (toolName === "subagent") {
        return {
          block: true,
          reason: "Subagent dispatch is restricted. Only the flow architect can dispatch subagents.",
        };
      }
      return undefined;
    });
  }

  // ── Tool whitelist enforcement (opt-in via AGENT_ALLOWED_TOOLS) ──
  const allowedToolsJson = process.env.AGENT_ALLOWED_TOOLS;
  if (allowedToolsJson) {
    let allowedTools: Set<string>;
    try {
      const parsed = JSON.parse(allowedToolsJson);
      allowedTools = new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      allowedTools = new Set(["finish"]); // Fail-safe: only finish allowed
    }
    // Ensure finish is always allowed
    allowedTools.add("finish");

    pi.on("tool_call", (event: any) => {
      const toolName = event.toolName || event.name;
      if (!allowedTools.has(toolName)) {
        return {
          block: true,
          reason: `Tool "${toolName}" not declared in agent frontmatter. Declared tools: ${[...allowedTools].filter(t => t !== "finish").join(", ")}`,
        };
      }
      return undefined;
    });
  }

  // ── Finish tool enforcement (opt-in via AGENT_REQUIRE_FINISH) ──
  if (process.env.AGENT_REQUIRE_FINISH === "1") {
    const MAX_RETRIES = 2;
    let finishCalled = false;
    let retries = 0;

    // Decision branches (optional — only set for decision steps)
    const branchesJson = process.env.AGENT_DECISION_BRANCHES;
    const decisionBranches: string[] | null = branchesJson
      ? JSON.parse(branchesJson)
      : null;

    // Build finish parameters — conditionally include branch field
    const baseParams: Record<string, any> = {
      status: Type.Union([
        Type.Literal("complete"),
        Type.Literal("error"),
        Type.Literal("blocked"),
      ], { description: "Result status" }),
      summary: Type.String({ description: "Brief summary of what was accomplished or what went wrong" }),
      files: Type.Array(Type.Object({
        path: Type.String({ description: "File path" }),
        action: Type.Union([
          Type.Literal("created"),
          Type.Literal("modified"),
          Type.Literal("read"),
        ], { description: "What was done to this file" }),
      }), { description: "Files created, modified, or read" }),
      artifacts: Type.Optional(Type.String({ description: "Optional structured data (XML or other)" })),
    };

    if (decisionBranches) {
      baseParams.branch = Type.Union(
        decisionBranches.map(b => Type.Literal(b)),
        { description: `Your decision. Must be one of: ${decisionBranches.join(", ")}` }
      );
    }

    pi.registerTool({
      name: "finish",
      label: "Finish",
      description: decisionBranches
        ? `Submit your decision and result. You MUST set branch to one of: ${decisionBranches.join(", ")}`
        : "Submit your final structured result. You MUST call this tool as your last action.",
      promptGuidelines: decisionBranches
        ? [
            "You MUST call the `finish` tool as your final action to submit your result.",
            `You MUST set the \`branch\` parameter to one of: ${decisionBranches.join(", ")}`,
            "Base your decision on the evidence in your analysis.",
          ]
        : [
            "You MUST call the `finish` tool as your final action to submit your result.",
            "Do NOT output a <result> XML block — use the `finish` tool instead.",
            "Provide a clear summary, list all files you created/modified/read, and set the correct status.",
          ],
      parameters: Type.Object(baseParams),
      execute: async () => {
        return {
          content: [{ type: "text" as const, text: "Result recorded." }],
          details: {},
        };
      },
    });

    pi.on("tool_call", (event: any) => {
      // Block all tool calls after finish — the agent must stop.
      // Some models (non-Anthropic) may continue calling tools after finish.
      if (finishCalled) {
        return { block: true, reason: "Agent has already called finish. No further tool calls allowed." };
      }
      if ((event.toolName || event.name) === "finish") {
        finishCalled = true;
      }
      return undefined;
    });

    pi.on("agent_end", () => {
      if (!finishCalled && retries < MAX_RETRIES) {
        retries++;
        pi.sendUserMessage(
          "You did not call the `finish` tool. You MUST call `finish` to submit your result.\n\n" +
          "Call it now with:\n" +
          "- status: \"complete\", \"error\", or \"blocked\"\n" +
          "- summary: brief description of what you did\n" +
          "- files: array of { path, action } for files you touched\n" +
          "- artifacts: (optional) any structured data",
          { deliverAs: "followUp" }
        );
      }
    });
  }

  const rulesPath = process.env.AGENT_ACCESS_RULES;
  if (!rulesPath) return; // No rules = no restrictions

  let rules: AccessRules;
  try {
    rules = JSON.parse(readFileSync(rulesPath, "utf-8"));
  } catch {
    // Fail-closed: if rules can't be read, block everything
    pi.on("tool_call", () => ({
      block: true,
      reason: "Guard: failed to load access rules",
    }));
    return;
  }

  // Resolve bare paths — patterns are used as-is (project-relative)
  function resolvePath(pattern: string): string {
    return pattern;
  }

  // Simple glob match (supports ** and *)
  function matchesPattern(filePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      const resolved = resolvePath(pattern);
      const regex = globToRegex(resolved);
      if (regex.test(filePath)) return true;
    }
    return false;
  }

  function globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u00a7\u00a7")
      .replace(/\*/g, "[^/]*")
      .replace(/\u00a7\u00a7/g, ".*");
    return new RegExp(`^${escaped}$`);
  }

  pi.on("tool_call", (event: any) => {
    const toolName = event.toolName || event.name;
    const params = event.params || event.input || {};

    // Check read access
    if (["Read", "read"].includes(toolName) && rules.read) {
      if (!matchesPattern(params.file_path || "", rules.read)) {
        return {
          block: true,
          reason: `Access denied: read not in allowed paths: ${params.file_path}`,
        };
      }
    }

    if (["Grep", "grep"].includes(toolName) && rules.read) {
      if (params.path && !matchesPattern(params.path, rules.read)) {
        return {
          block: true,
          reason: `Access denied: grep path not in allowed paths: ${params.path}`,
        };
      }
    }

    // Check write access
    if (["Write", "write", "Edit", "edit"].includes(toolName) && rules.write) {
      if (!matchesPattern(params.file_path || "", rules.write)) {
        return {
          block: true,
          reason: `Access denied: write not in allowed paths: ${params.file_path}`,
        };
      }
    }

    // Check bash deny list
    if (["Bash", "bash"].includes(toolName) && rules.bash?.deny) {
      const cmd = params.command || "";
      for (const denied of rules.bash.deny) {
        if (cmd.includes(denied)) {
          return {
            block: true,
            reason: `Access denied: command contains denied pattern: ${denied}`,
          };
        }
      }
      // Check bash redirect targets against write rules
      if (rules.write) {
        const redirectMatch = cmd.match(/(?:>|>>|tee\s+)(\S+)/g);
        if (redirectMatch) {
          for (const match of redirectMatch) {
            const target = match.replace(/^(?:>>?|tee\s+)/, "").trim();
            if (!matchesPattern(target, rules.write)) {
              return {
                block: true,
                reason: `Access denied: redirect target not in allowed paths: ${target}`,
              };
            }
          }
        }
      }
    }

    return undefined; // Allow
  });
}
