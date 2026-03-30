// ---------------------------------------------------------------------------
// Box Renderer
//
// Reusable utility for rendering bordered TUI boxes. Consolidates the
// repeated ┌─┐ │pad│ └─┘ pattern used across overlays and widgets.
// ---------------------------------------------------------------------------

import { visibleWidth } from "@mariozechner/pi-tui";

/** Pad a line (which may contain ANSI codes) with trailing spaces to exactly `targetWidth` visible characters. */
export function padLine(line: string, targetWidth: number): string {
  const vw = visibleWidth(line);
  if (vw >= targetWidth) return line;
  return line + " ".repeat(targetWidth - vw);
}

export interface BoxOptions {
  /** Total width of the box (including border characters). */
  width: number;
  /** Theme object with `fg(color, text)` for styling borders. */
  theme: any;
  /** Optional title rendered in the top border: ┌─ Title ──┐ */
  title?: string;
  /** Content lines to render inside the box. */
  content: string[];
  /** Footer lines rendered after a ├──┤ separator, before the bottom border. */
  footer?: string[];
  /** Content line indices after which to insert ├──┤ separators (0-based). */
  separatorAfter?: number[];
}

/**
 * Render a bordered box around content lines.
 *
 * Returns an array of strings representing the box:
 *   ┌─ Title ──────┐   (or ┌──────┐ without title)
 *   │ content       │
 *   ├───────────────┤   (if separatorAfter includes that index)
 *   │ more content  │
 *   ├───────────────┤   (footer separator)
 *   │ footer        │
 *   └───────────────┘
 */
export function renderBox(opts: BoxOptions): string[] {
  const { width, theme, title, content, footer, separatorAfter } = opts;
  const fg = (c: string, t: string) => theme?.fg?.(c, t) ?? t;
  const bord = (s: string) => fg("dim", s);

  const w = width - 2; // inner width between │ borders
  const innerWidth = Math.max(0, w - 2); // content area (1 space padding each side)

  const lines: string[] = [];

  // ── Top border ──
  if (title) {
    const titleDisplay = ` ${title} `;
    const titleLen = titleDisplay.length;
    const afterTitle = Math.max(0, w - titleLen - 1); // -1 for the ─ before title
    lines.push(
      bord("┌─") +
      fg("accent", titleDisplay) +
      bord("─".repeat(afterTitle) + "┐"),
    );
  } else {
    lines.push(bord("┌" + "─".repeat(w) + "┐"));
  }

  // ── Content lines ──
  const sepSet = new Set(separatorAfter || []);
  for (let i = 0; i < content.length; i++) {
    lines.push(bord("│") + " " + padLine(content[i], innerWidth) + " " + bord("│"));
    if (sepSet.has(i)) {
      lines.push(bord("├" + "─".repeat(w) + "┤"));
    }
  }

  // ── Footer ──
  if (footer && footer.length > 0) {
    lines.push(bord("├" + "─".repeat(w) + "┤"));
    for (const line of footer) {
      lines.push(bord("│") + " " + padLine(line, innerWidth) + " " + bord("│"));
    }
  }

  // ── Bottom border ──
  lines.push(bord("└" + "─".repeat(w) + "┘"));

  return lines;
}
