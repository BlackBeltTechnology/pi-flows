import type { DetailEntry } from "./agent-dashboard.js";

// ── Scroll state ──────────────────────────────────────────────────────────────

export interface DetailScrollState {
  scrollOffset: number;
  selectedIndex: number;
  expandedIndex: number; // -1 = none expanded (BROWSING mode), >=0 = EXPANDED mode
  contentScroll: number; // line offset within expanded content (EXPANDED mode only)
}

export function createDetailScrollState(initialIndex?: number): DetailScrollState {
  const idx = initialIndex != null && initialIndex >= 0 ? initialIndex : 0;
  return { scrollOffset: 0, selectedIndex: idx, expandedIndex: -1, contentScroll: 0 };
}

/**
 * Move up. In EXPANDED mode, scroll content up one line.
 * In BROWSING mode, move to previous entry.
 */
export function moveUp(state: DetailScrollState): void {
  if (state.expandedIndex >= 0) {
    // EXPANDED mode: scroll content
    if (state.contentScroll > 0) {
      state.contentScroll--;
    }
  } else {
    // BROWSING mode: move between entries
    if (state.selectedIndex > 0) {
      state.selectedIndex--;
      if (state.selectedIndex < state.scrollOffset) {
        state.scrollOffset = state.selectedIndex;
      }
    }
  }
}

/**
 * Move down. In EXPANDED mode, scroll content down one line.
 * In BROWSING mode, move to next entry.
 * @param maxContentLines - total lines of expanded content (only used in EXPANDED mode)
 * @param viewportHeight - visible lines in viewport (only used in EXPANDED mode)
 */
export function moveDown(state: DetailScrollState, entryCount: number, maxContentLines?: number, viewportHeight?: number): void {
  if (state.expandedIndex >= 0 && maxContentLines !== undefined && viewportHeight !== undefined) {
    // EXPANDED mode: scroll content
    const maxScroll = Math.max(0, maxContentLines - viewportHeight);
    if (state.contentScroll < maxScroll) {
      state.contentScroll++;
    }
  } else {
    // BROWSING mode: move between entries
    if (state.selectedIndex < entryCount - 1) {
      state.selectedIndex++;
    }
  }
}

export function toggleExpand(state: DetailScrollState): void {
  if (state.expandedIndex === state.selectedIndex) {
    // Collapse — restore scroll to where the entry was in browsing mode
    state.expandedIndex = -1;
    state.contentScroll = 0;
  } else {
    // Expand — contentScroll will be set by the render function
    // to the expanded entry's start line (see renderDetailView)
    state.expandedIndex = state.selectedIndex;
    state.contentScroll = -1; // signal: needs positioning
  }
}

// ── Compact tool call formatting ──────────────────────────────────────────────

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - 3)) + "...";
}

function inputPreview(toolName: string, input: any): string {
  if (!input) return "";
  switch (toolName) {
    case "Read": case "read":
    case "Write": case "write":
    case "Edit": case "edit":
      return ((input.file_path || input.path || "") as string).split("/").pop() || "";
    case "Grep": case "grep":
      return (input.pattern || "").slice(0, 30);
    case "Bash": case "bash":
      return (input.command || "").slice(0, 30);
    default: {
      const s = typeof input === "string" ? input : JSON.stringify(input);
      return s.slice(0, 30);
    }
  }
}

/** Word-wrap a string to fit within a given width. */
function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const result: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      result.push(rawLine);
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      // Try to break at a space
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      result.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining) result.push(remaining);
  }
  return result;
}

// ── Render detail view ────────────────────────────────────────────────────────

export interface DetailViewData {
  agentName: string;
  status: string;
  summary?: string;
  entries: DetailEntry[];
}

/**
 * Render the detail view for a single agent.
 *
 * Uses a "render all lines, then slice viewport" approach:
 * 1. Generate the full virtual document of all lines.
 * 2. In EXPANDED mode, slice by contentScroll.
 * 3. In BROWSING mode, use entry-based scrollOffset to keep selectedIndex visible.
 */
export function renderDetailView(
  data: DetailViewData,
  scroll: DetailScrollState,
  width: number,
  theme: any,
  targetHeight: number,
  showThinking = true,
): string[] {
  const fg = (c: string, t: string) => theme?.fg?.(c, t) ?? t;
  const inner = width - 4;

  // Filter entries based on showThinking
  const entries = showThinking
    ? data.entries
    : data.entries.filter(e => e.kind !== "thinking");

  // ── Build header ──
  const headerLines: string[] = [];
  const statusIcon = data.status === "complete" ? "✓"
    : data.status === "error" ? "✗"
    : data.status === "running" ? "●" : "○";
  const statusColor = data.status === "complete" ? "success"
    : data.status === "error" ? "error"
    : data.status === "running" ? "accent" : "dim";

  const toolCount = entries.filter(e => e.kind === "tool").length;
  const msgCount = entries.filter(e => e.kind === "text").length;
  const errCount = entries.filter(e => e.kind === "error").length;
  const countParts: string[] = [];
  if (toolCount > 0) countParts.push(`${toolCount} tools`);
  if (msgCount > 0) countParts.push(`${msgCount} messages`);
  if (errCount > 0) countParts.push(`${errCount} ${errCount === 1 ? "error" : "errors"}`);
  const countStr = countParts.length > 0 ? countParts.join(" · ") : "no activity";

  headerLines.push(`  ${fg(statusColor, statusIcon)} ${fg("accent", data.agentName)} — ${fg("dim", data.status)} · ${countStr}`);
  headerLines.push(fg("dim", "  " + "─".repeat(Math.max(0, inner))));

  // ── Build footer ──
  const thinkingHint = showThinking ? "ctrl+t hide thinking" : "ctrl+t show thinking";
  const footerLines = [
    "",
    fg("dim", `  Backspace back · ↑ ↓ ${scroll.expandedIndex >= 0 ? "scroll" : "navigate"} · Enter ${scroll.expandedIndex >= 0 ? "collapse" : "expand"} · ${thinkingHint}`),
  ];

  // ── Viewport budget ──
  const viewportHeight = targetHeight - headerLines.length - footerLines.length;

  // ── Build content lines (virtual document) ──
  const contentLines: string[] = [];

  // Summary block (full text, word-wrapped, scrollable)
  if (data.summary) {
    contentLines.push("  " + fg("dim", "Summary:"));
    const summaryWrapped = wordWrap(data.summary, Math.max(10, inner - 4));
    for (const sl of summaryWrapped) {
      contentLines.push("    " + sl);
    }
    contentLines.push("");
  }

  // Track which content-line indices correspond to each entry (for scroll targeting)
  const entryStartLines: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    entryStartLines.push(contentLines.length);

    if (e.kind === "text") {
      // Render as wrapped paragraph with indent
      const wrapped = wordWrap(e.text, Math.max(10, inner - 2));
      for (const wl of wrapped) {
        contentLines.push("  " + fg("muted", wl));
      }
      contentLines.push(""); // blank line after text
    } else if (e.kind === "thinking") {
      // Render as dimmed block
      const wrapped = wordWrap(e.text, Math.max(10, inner - 4));
      contentLines.push("  " + fg("dim", "thinking:"));
      for (const wl of wrapped) {
        contentLines.push("    " + fg("dim", wl));
      }
      contentLines.push("");
    } else if (e.kind === "error") {
      // Render as error block with ✗ prefix
      const errWrapped = wordWrap(e.text, Math.max(10, inner - 4));
      contentLines.push("  " + fg("error", "✗ Error:"));
      for (const wl of errWrapped) {
        contentLines.push("    " + fg("error", wl));
      }
      contentLines.push("");
    } else if (e.kind === "tool") {
      const sel = i === scroll.selectedIndex ? ">" : " ";
      const icon = e.isError ? fg("error", "✗") : fg("success", "✓");
      const preview = truncate(inputPreview(e.toolName, e.input).replace(/[\n\r]+/g, " "), Math.max(0, width - 22));
      const toolIdx = entries.slice(0, i + 1).filter(x => x.kind === "tool").length;
      const line = `${sel} ${toolIdx}. ${icon} ${fg("dim", e.toolName)} ${preview}`;
      contentLines.push(truncate(line, width));

      // If this entry is expanded, render full input/output
      if (i === scroll.expandedIndex) {
        const inputStr = typeof e.input === "string" ? e.input : (e.input != null ? JSON.stringify(e.input, null, 2) : "(no input)");
        const outputStr = typeof e.output === "string" ? (e.output || "(no output)") : (e.output != null ? JSON.stringify(e.output, null, 2) : "(pending...)");

        contentLines.push(fg("dim", "    Input:"));
        for (const l of inputStr.split("\n")) {
          contentLines.push(("      " + l).slice(0, width));
        }
        contentLines.push(fg("dim", "    Output:"));
        for (const l of outputStr.split("\n")) {
          contentLines.push(("      " + l).slice(0, width));
        }
      }
    }
  }

  // ── Viewport slicing ──
  let visibleContent: string[];

  if (scroll.expandedIndex >= 0) {
    // EXPANDED mode: line-by-line scroll through the full content
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    // Position to expanded entry on first open (contentScroll === -1)
    if (scroll.contentScroll < 0) {
      const expandedStart = entryStartLines[scroll.expandedIndex] ?? 0;
      scroll.contentScroll = Math.min(expandedStart, maxScroll);
    }
    if (scroll.contentScroll > maxScroll) scroll.contentScroll = maxScroll;
    visibleContent = contentLines.slice(scroll.contentScroll, scroll.contentScroll + viewportHeight);
  } else {
    // BROWSING mode: entry-based scroll — ensure selectedIndex is visible
    // Find the line range of the selected entry
    const selStart = entryStartLines[scroll.selectedIndex] ?? 0;

    // Adjust scrollOffset (line-based in browsing too) to keep selected visible
    if (scroll.scrollOffset > selStart) {
      scroll.scrollOffset = selStart;
    }
    // If selected entry starts past the viewport bottom, scroll down
    if (selStart >= scroll.scrollOffset + viewportHeight) {
      scroll.scrollOffset = selStart - viewportHeight + 1;
    }
    // Clamp
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (scroll.scrollOffset > maxScroll) scroll.scrollOffset = maxScroll;
    if (scroll.scrollOffset < 0) scroll.scrollOffset = 0;

    visibleContent = contentLines.slice(scroll.scrollOffset, scroll.scrollOffset + viewportHeight);
  }

  // ── Assemble output ──
  const lines: string[] = [];
  lines.push(...headerLines);
  lines.push(...visibleContent);
  lines.push(...footerLines);

  // Pad to target height
  while (lines.length < targetHeight) {
    lines.push("");
  }

  return lines;
}

/**
 * Compute total content lines for the expanded view (used by moveDown for scroll bounds).
 */
export function computeExpandedContentLines(
  entries: DetailEntry[],
  scroll: DetailScrollState,
  width: number,
  showThinking: boolean,
  summary?: string,
): number {
  const filtered = showThinking ? entries : entries.filter(e => e.kind !== "thinking");
  const inner = width - 4;
  let total = 0;

  // Account for summary block
  if (summary) {
    total += 1 + wordWrap(summary, Math.max(10, inner - 4)).length + 1; // label + wrapped lines + blank
  }

  for (let i = 0; i < filtered.length; i++) {
    const e = filtered[i];
    if (e.kind === "text") {
      total += wordWrap(e.text, Math.max(10, inner - 2)).length + 1;
    } else if (e.kind === "thinking") {
      total += wordWrap(e.text, Math.max(10, inner - 4)).length + 2;
    } else if (e.kind === "error") {
      total += wordWrap(e.text, Math.max(10, inner - 4)).length + 2; // label + wrapped lines + blank
    } else if (e.kind === "tool") {
      total += 1; // one-liner
      if (i === scroll.expandedIndex) {
        const inputStr = typeof e.input === "string" ? e.input : (e.input != null ? JSON.stringify(e.input, null, 2) : "(no input)");
        const outputStr = typeof e.output === "string" ? (e.output || "(no output)") : (e.output != null ? JSON.stringify(e.output, null, 2) : "(pending...)");
        total += 1 + inputStr.split("\n").length + 1 + outputStr.split("\n").length;
      }
    }
  }
  return total;
}
