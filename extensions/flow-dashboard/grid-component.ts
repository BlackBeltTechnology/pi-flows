import { AgentCard } from "./agent-card.js";
import { Text } from "@mariozechner/pi-tui";

export const MIN_CARD_WIDTH = 40;
export const CARD_HEIGHT = 8;
const GAP = 1;

export class GridComponent {
  private cards: AgentCard[] = [];
  private theme: any;
  private text = new Text("", 0, 1);
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

      // Pad incomplete rows with empty space columns
      while (rendered.length < cols) {
        rendered.push(Array(CARD_HEIGHT).fill(" ".repeat(colWidth)));
      }

      for (let line = 0; line < CARD_HEIGHT; line++) {
        rows.push(rendered.map(r => r[line] ?? " ".repeat(colWidth)));
      }
    }

    const output = rows.map(cols => cols.join(" ".repeat(GAP)));
    this.text.setText(output.join("\n"));
    return this.text.render(width);
  }

  invalidate(): void { this.text.invalidate(); }
}
