// ---------------------------------------------------------------------------
// Post-flow summary rendering
//
// Pure render helpers for the post-flow summary widget. Produces the frozen
// agent-card grid (from the preserved `lastCards` snapshot) stacked above the
// per-agent summary lines. Extracted from flow-tui.ts so it is unit-testable.
// ---------------------------------------------------------------------------

import { GridComponent } from "../flow-dashboard/grid-component.js";
import type { AgentCard } from "../flow-dashboard/agent-card.js";
import { renderBox } from "../flow-dashboard/box-renderer.js";
import type { FlowResult } from "../flow-engine/types.js";

export interface SummaryStats {
  agentCount: number;
  duration: string;
  fileCount: number;
  perAgent: { name: string; status: string; fileCount: number }[];
}

export interface SummaryContentOpts {
  flowResult: FlowResult;
  stats: SummaryStats;
  hasIssue: boolean;
  nextStep: string | null;
  cards: Map<string, AgentCard> | null;
  theme: any;
  width: number;
}

/**
 * Render the preserved agent cards in grid layout, frozen and read-only.
 * Renders EVERY card in the snapshot, in insertion order, mirroring exactly
 * what the live dashboard grid showed — including subagents/fork/loop cards
 * that are not top-level keys in `fr.results`. Returns [] when no cards exist.
 */
export function renderFrozenCards(
  cards: Map<string, AgentCard> | null,
  theme: any,
  width: number,
): string[] {
  if (!cards || cards.size === 0) return [];

  const grid = new GridComponent();
  grid.setCards(Array.from(cards.values()));
  grid.setTheme(theme);
  grid.setSelectedIndex(-1); // read-only: no selection highlight
  return grid.render(width);
}

/**
 * Render the full post-flow summary content for summary (default) mode:
 * the frozen card grid above the per-agent summary lines + next-step hint.
 */
export function renderSummaryContent(opts: SummaryContentOpts): string[] {
  const { flowResult: fr, stats, hasIssue, nextStep, cards, theme, width } = opts;
  const inner = width - 4;
  const statusIcon = hasIssue ? "⚠" : "✓";

  // ── Summary box (status header + per-agent lines + next-step) ──
  const content: string[] = [];
  const separators: number[] = [];

  const header = `${statusIcon} ${fr.flowName} complete · ${stats.agentCount} agents · ${stats.duration}`;
  content.push(theme.fg("accent", header));
  separators.push(0);

  for (const agent of stats.perAgent) {
    const icon =
      agent.status === "complete"
        ? theme.fg("success", "✓")
        : agent.status === "skipped"
          ? theme.fg("dim", "✓")
          : agent.status === "blocked"
            ? theme.fg("warning", "⚠")
            : agent.status === "error"
              ? theme.fg("error", "⚠")
              : theme.fg("dim", "○");
    const detail = agent.fileCount > 0 ? ` (${agent.fileCount} files)` : "";
    content.push(`${icon} ${agent.name}${detail}`);
    const agentSummary = fr.results[agent.name]?.summary;
    if (agentSummary) {
      const maxLen = inner - 4;
      const trimmed =
        agentSummary.length > maxLen
          ? agentSummary.slice(0, maxLen - 1) + "…"
          : agentSummary;
      content.push(theme.fg("dim", `  ${trimmed}`));
    }
  }

  if (nextStep) {
    separators.push(content.length - 1);
    content.push(theme.fg("warning", `Next: /${nextStep}`));
  }

  const box = renderBox({
    width,
    theme,
    content,
    separatorAfter: separators,
    footer: [theme.fg("dim", "alt+o inspect agents · alt+x dismiss")],
  });

  // ── Frozen cards stacked above the summary box ──
  const cardLines = renderFrozenCards(cards, theme, width);
  return cardLines.length > 0 ? [...cardLines, ...box] : box;
}
