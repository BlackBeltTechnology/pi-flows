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
  render: (theme?: any) => string | null;
}

const segments: FooterSegment[] = [];
const segmentInvalidators = new Map<string, () => void>();

// ---- Context usage helpers -------------------------------------------------

function buildBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function usageColor(percent: number): "success" | "warning" | "error" {
  if (percent <= 60) return "success";
  if (percent <= 80) return "warning";
  return "error";
}

// ---- Extension activation -------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const cwd = process.cwd();
  let cachedBranch = "";
  let tui: any = null;
  let currentModel: any = null;

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
    currentModel = ctx.model;

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
          if (currentModel) {
            const friendlyName = currentModel.name ?? currentModel.id;
            parts.push(`${currentModel.provider} · ${friendlyName}`);
          } else {
            parts.push("– · –");
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

          // Context window bar (percentage of context used)
          const ctxUsage = ctx.getContextUsage();
          if (ctxUsage) {
            const pct = (ctxUsage.percent ?? 0).toFixed(1);
            const bar = buildBar(ctxUsage.percent ?? 0);
            const color = usageColor(ctxUsage.percent ?? 0);
            parts.push(theme.fg(color, `${bar} ${pct}%`));
          }

          // Domain segments
          for (const segment of segments) {
            const rendered = segment.render(theme);
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

  // Track model changes
  pi.on("model_select", async (_event, ctx) => {
    if (ctx.model) {
      currentModel = ctx.model;
      tui?.requestRender();
    }
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
