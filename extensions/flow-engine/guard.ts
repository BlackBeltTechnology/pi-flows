// ---------------------------------------------------------------------------
// Guard Extension -- Sandboxes spawned subagent sessions
//
// Primary API: createGuardExtension(options) — parameterized factory for
// in-process SDK sessions. No env vars, no temp files.
//
// Legacy: guardExtension() default export — reads env vars for backward
// compatibility with direct --extension guard.ts usage.
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";

interface AccessRules {
  read?: string[];
  write?: string[];
  bash?: { deny: string[] };
}

export interface GuardOptions {
  allowedTools?: string[];
  requireFinish?: boolean;
  accessRules?: AccessRules;
  decisionBranches?: string[];
  allowAskUser?: boolean;
}

/**
 * Create a guard extension factory with direct parameter passing.
 * This is the primary API — no env vars, no temp files.
 */
export function createGuardExtension(options: GuardOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    // Block ask_user unless explicitly allowed
    if (!options.allowAskUser) {
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
    }

    // ── Tool whitelist enforcement ──
    if (options.allowedTools) {
      const allowedTools = new Set(options.allowedTools);
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

    // ── Finish tool enforcement ──
    // NOTE: The agent_end → followUp retry does NOT work in-process because
    // Agent.emit() doesn't await async listeners. The retry loop is handled
    // in spawnAgent() instead. The guard only registers the tool and blocks
    // post-finish calls.
    if (options.requireFinish) {
      let finishCalled = false;

      const decisionBranches = options.decisionBranches ?? null;

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
        if (finishCalled) {
          return { block: true, reason: "Agent has already called finish. No further tool calls allowed." };
        }
        if ((event.toolName || event.name) === "finish") {
          finishCalled = true;
        }
        return undefined;
      });

    }

    // ── Access rules enforcement ──
    const rules = options.accessRules;
    if (!rules) return;

    // Simple glob match (supports ** and *)
    function matchesPattern(filePath: string, patterns: string[]): boolean {
      for (const pattern of patterns) {
        const regex = globToRegex(pattern);
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

      if (toolName === "read" && rules.read) {
        if (!matchesPattern(params.file_path || "", rules.read)) {
          return { block: true, reason: `Access denied: read not in allowed paths: ${params.file_path}` };
        }
      }

      if (toolName === "grep" && rules.read) {
        if (params.path && !matchesPattern(params.path, rules.read)) {
          return { block: true, reason: `Access denied: grep path not in allowed paths: ${params.path}` };
        }
      }

      if ((toolName === "write" || toolName === "edit") && rules.write) {
        if (!matchesPattern(params.file_path || "", rules.write)) {
          return { block: true, reason: `Access denied: write not in allowed paths: ${params.file_path}` };
        }
      }

      if (toolName === "bash" && rules.bash?.deny) {
        const cmd = params.command || "";
        for (const denied of rules.bash.deny) {
          if (cmd.includes(denied)) {
            return { block: true, reason: `Access denied: command contains denied pattern: ${denied}` };
          }
        }
        if (rules.write) {
          const redirectMatch = cmd.match(/(?:>|>>|tee\s+)(\S+)/g);
          if (redirectMatch) {
            for (const match of redirectMatch) {
              const target = match.replace(/^(?:>>?|tee\s+)/, "").trim();
              if (!matchesPattern(target, rules.write)) {
                return { block: true, reason: `Access denied: redirect target not in allowed paths: ${target}` };
              }
            }
          }
        }
      }

      return undefined;
    });
  };
}

/**
 * Guard extension injected into spawned agent processes.
 * Thin wrapper that reads env vars and delegates to createGuardExtension().
 * Kept for backward compat with any direct `--extension guard.ts` usage.
 */
export default function guardExtension(pi: ExtensionAPI) {
  // Read config from env vars (legacy path)
  const allowedToolsJson = process.env.AGENT_ALLOWED_TOOLS;
  let allowedTools: string[] | undefined;
  if (allowedToolsJson) {
    try { allowedTools = JSON.parse(allowedToolsJson); } catch { allowedTools = ["finish"]; }
  }

  const branchesJson = process.env.AGENT_DECISION_BRANCHES;
  let decisionBranches: string[] | undefined;
  if (branchesJson) {
    try { decisionBranches = JSON.parse(branchesJson); } catch { /* ignore */ }
  }

  let accessRules: AccessRules | undefined;
  const rulesPath = process.env.AGENT_ACCESS_RULES;
  if (rulesPath) {
    try { accessRules = JSON.parse(readFileSync(rulesPath, "utf-8")); } catch { /* ignore */ }
  }

  const factory = createGuardExtension({
    allowedTools,
    requireFinish: process.env.AGENT_REQUIRE_FINISH === "1",
    accessRules,
    decisionBranches,
    allowAskUser: process.env.AGENT_SPAWN_MODE === "rpc",
  });

  factory(pi);
}
