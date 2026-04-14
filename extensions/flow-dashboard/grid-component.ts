import { AgentCard } from "./agent-card.js";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

export const MIN_CARD_WIDTH = 40;
export const CARD_HEIGHT = 8;
const GAP = 1;

export class GridComponent {
  private cards: AgentCard[] = [];
  private theme: any;
  private _selectedIndex = -1; // -1 = no selection

  setCards(cards: AgentCard[]): void { this.cards = cards; }
  setTheme(theme: any): void { this.theme = theme; }
  setSelectedIndex(index: number): void { this._selectedIndex = index; }

  /** Compute column count for a given width (exposed for navigation math). */
  static computeCols(cardCount: number, width: number): number {
    return Math.min(cardCount, Math.max(1, Math.floor((width + GAP) / (MIN_CARD_WIDTH + GAP))));
  }

  render(width: number): string[] {
    if (this.cards.length === 0) return [];

    const cols = GridComponent.computeCols(this.cards.length, width);
    const colWidth = Math.floor((width - GAP * (cols - 1)) / cols);
    const rows: string[][] = [];

    for (let r = 0; r < Math.ceil(this.cards.length / cols); r++) {
      const rowCards = this.cards.slice(r * cols, (r + 1) * cols);
      const startIdx = r * cols;
      const rendered = rowCards.map((c, i) =>
        c.render(colWidth, this.theme, startIdx + i === this._selectedIndex)
      );

      // Compute row height from actual rendered card lines (not hardcoded)
      const rowHeight = Math.max(CARD_HEIGHT, ...rendered.map(r => r.length));

      // Pad incomplete rows with empty space columns
      while (rendered.length < cols) {
        rendered.push(Array(rowHeight).fill(" ".repeat(colWidth)));
      }

      for (let line = 0; line < rowHeight; line++) {
        rows.push(rendered.map(r => r[line] ?? " ".repeat(colWidth)));
      }
    }

    // Join columns with gap and pad each line to exactly `width` visible chars
    const emptyLine = " ".repeat(width);
    const output: string[] = [emptyLine]; // padding before grid (replaces Text paddingY=1)

    for (const cols of rows) {
      let joined = cols.join(" ".repeat(GAP));
      const vw = visibleWidth(joined);
      if (vw < width) {
        joined += " ".repeat(width - vw);
      } else if (vw > width) {
        joined = truncateToWidth(joined, width);
      }
      output.push(joined);
    }

    output.push(emptyLine); // padding after grid (replaces Text paddingY=1)
    return output;
  }
}
