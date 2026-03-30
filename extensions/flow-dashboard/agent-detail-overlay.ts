// ---------------------------------------------------------------------------
// Agent Detail Overlay
//
// TUI Component that renders agent tool call / model response history
// as an overlay on top of the dashboard or summary widget.
// Uses the existing renderDetailView() for content rendering.
// ---------------------------------------------------------------------------

import type { DetailEntry } from "./agent-dashboard.js";
import {
  renderDetailView,
  createDetailScrollState,
  moveUp,
  moveDown,
  toggleExpand,
  computeExpandedContentLines,
  type DetailScrollState,
} from "./detail-view.js";
import { renderBox } from "./box-renderer.js";

// Key constants
const KEY_ESC = "\x1b";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_BACKSPACE_1 = "\x7f";
const KEY_BACKSPACE_2 = "\b";
const KEY_CTRL_T = "\x14";

export interface AgentDetailOverlayOptions {
  agentName: string;
  status: string;
  summary?: string;
  entries: DetailEntry[];
  theme: any;
  tui: any;
  done: (result: null) => void;
}

/**
 * Create an agent detail overlay component.
 * Implements the TUI Component interface: render(), handleInput(), invalidate().
 */
export function createAgentDetailOverlay(opts: AgentDetailOverlayOptions) {
  const { agentName, status, summary, entries, theme, tui, done } = opts;

  const scroll: DetailScrollState = createDetailScrollState(Math.max(0, entries.length - 1));
  let showThinking = true;

  return {
    render(width: number): string[] {
      const termRows = tui?.terminal?.rows ?? 40;
      // Account for top + bottom border in target height
      const innerHeight = Math.max(20, Math.floor(termRows * 0.85) - 6);
      const innerWidth = Math.max(20, width - 4); // 2 for border chars + 1 space padding each side

      const contentLines = renderDetailView(
        { agentName, status, summary, entries },
        scroll,
        innerWidth,
        theme,
        innerHeight,
        showThinking,
      );

      return renderBox({ width, theme, content: contentLines });
    },

    handleInput(data: string): void {
      if (data === KEY_ESC || data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
        done(null);
        return;
      }

      if (data === KEY_CTRL_T) {
        showThinking = !showThinking;
        tui?.requestRender();
        return;
      }

      if (data === KEY_UP) {
        moveUp(scroll);
        tui?.requestRender();
        return;
      }

      if (data === KEY_DOWN) {
        const filtered = showThinking
          ? entries
          : entries.filter(e => e.kind !== "thinking");
        const termRows = tui?.terminal?.rows ?? 40;
        const innerHeight = Math.max(20, Math.floor(termRows * 0.85) - 6);
        const termWidth = tui?.terminal?.columns ?? 120;
        const innerWidth = Math.max(20, termWidth - 4);
        const viewportHeight = innerHeight - 6; // approximate header+footer
        const totalLines = computeExpandedContentLines(
          filtered,
          scroll,
          innerWidth,
          showThinking,
          summary,
        );
        moveDown(scroll, filtered.length, totalLines, viewportHeight);
        tui?.requestRender();
        return;
      }

      if (data === KEY_ENTER) {
        toggleExpand(scroll);
        tui?.requestRender();
        return;
      }
    },

    invalidate(): void {},
  };
}
