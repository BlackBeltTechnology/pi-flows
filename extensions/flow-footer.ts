// ---------------------------------------------------------------------------
// Flow Footer Extension
//
// Provides a composable footer with base segments (provider/model, git branch,
// file stats) and extension points for domain packages to register additional
// segments via flow:register-footer-segment events.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getFileStats, onFileStatsChange } from "./file-tracker.js";
import { execSync } from "node:child_process";

// ---- Footer segment registry ----------------------------------------------

interface FooterSegment {
  name: string;
  render: () => string | null;
}

const segments: FooterSegment[] = [];
const segmentInvalidators = new Map<string, () => void>();

// ---- Context usage helpers -------------------------------------------------

function formatTokens(n: number): string {
  return Math.round(n / 1000) + "k";
}

function buildBar(percent: number): string {
  const filled = Math.round((percent / 100) * 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function usageColor(percent: number): "success" | "warning" | "error" {
  if (percent <= 60) return "success";
  if (percent <= 80) return "warning";
  return "error";
}

// ---- Extension activation -------------------------------------------------

export default function activate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  let cachedBranch = "";
  let tui: any = null;

  function refreshBranch(): void {
    try {
      cachedBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
    } catch {
      cachedBranch = "";
    }
  }

  refreshBranch();

  // Register footer segments from domain packages
  pi.events?.on("flow:register-footer-segment", (data: any) => {
    const { name, render } = data || {};
    if (!name || typeof render !== "function") return;

    // Replace existing segment with same name
    const idx = segments.findIndex(s => s.name === name);
    if (idx >= 0) {
      segments[idx] = { name, render };
    } else {
      segments.push({ name, render });
    }

    // Provide invalidate callback to registrant
    const invalidate = () => tui?.requestRender();
    segmentInvalidators.set(name, invalidate);
    if (data.onRegistered) data.onRegistered(invalidate);
  });

  // Track file stats changes for re-render
  onFileStatsChange(() => tui?.requestRender());

  pi.on("session_start", async (_event, ctx) => {
    // Try to import provider info
    let getSessionInfo: (() => { provider: string; modelId: string }) | undefined;
    let getModelDisplayName: ((id: string) => string) | undefined;

    try {
      const providerMod = await import("./provider-register.js");
      getSessionInfo = providerMod.getSessionInfo;
      getModelDisplayName = providerMod.getModelDisplayName;
    } catch { /* provider-register not available */ }

    ctx.ui.setFooter((tuiInstance, theme, footerData) => {
      tui = tuiInstance;

      const branchDispose = footerData.onBranchChange(() => {
        refreshBranch();
        tui?.requestRender();
      });

      return {
        render(width: number): string[] {
          const parts: string[] = [];

          // Provider · Model
          if (getSessionInfo) {
            const session = getSessionInfo();
            if (session.provider && getModelDisplayName) {
              const friendlyName = getModelDisplayName(session.modelId);
              parts.push(`${session.provider} · ${friendlyName}`);
            } else if (ctx.model) {
              const friendlyName = getModelDisplayName?.(ctx.model.id) ?? ctx.model.id;
              parts.push(`${ctx.model.provider} · ${friendlyName}`);
            } else {
              parts.push("– · –");
            }
          }

          // Git branch
          parts.push(`⎇ ${cachedBranch || "–"}`);

          // File stats
          const stats = getFileStats();
          if (stats.fileCount > 0) {
            const diffStr = `${stats.fileCount} files ` +
              theme.fg("success", `+${stats.insertions}`) + " " +
              theme.fg("error", `-${stats.deletions}`);
            parts.push(diffStr);
          } else {
            parts.push("0 files");
          }

          // Accumulated session token usage (matches pi's built-in FooterComponent)
          let totalInput = 0;
          let totalOutput = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && (entry as any).message?.role === "assistant") {
              const usage = (entry as any).message.usage;
              if (usage) {
                totalInput += usage.input || 0;
                totalOutput += usage.output || 0;
              }
            }
          }

          // Context window bar (percentage of context used)
          const ctxUsage = ctx.getContextUsage();
          if (ctxUsage) {
            const bar = buildBar(ctxUsage.percent ?? 0);
            const max = formatTokens(ctxUsage.contextWindow);
            const color = usageColor(ctxUsage.percent ?? 0);
            const tokenStats = `↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`;
            parts.push(theme.fg(color, `${bar} ${tokenStats} / ${max}`));
          } else if (totalInput > 0 || totalOutput > 0) {
            parts.push(`↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`);
          }

          // Domain segments
          for (const segment of segments) {
            const rendered = segment.render();
            if (rendered) parts.push(rendered);
          }

          const line = parts.join(" │ ");
          return [line.length > width ? line.slice(0, width) : line];
        },
        invalidate() {},
        dispose: branchDispose,
      };
    });
  });

  // Refresh context usage after each LLM turn
  pi.on("turn_end", () => {
    tui?.requestRender();
  });

  // Refresh branch after flow completion
  pi.events?.on("flow:complete", () => {
    refreshBranch();
  });
}
