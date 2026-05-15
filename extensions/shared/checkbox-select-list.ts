// ---------------------------------------------------------------------------
// CheckboxSelectList — Multi-select with Space toggle, [✓]/[ ] prefixes
//
// Usage:
//   const list = new CheckboxSelectList(items, 10, theme);
//   list.onConfirm = (selected) => done(selected);
//   list.onCancel = () => done([]);
// ---------------------------------------------------------------------------

import {
  SelectList,
  type SelectItem,
  type SelectListTheme,
  getKeybindings,
} from "@earendil-works/pi-tui";

export class CheckboxSelectList {
  #items: SelectItem[];
  #toggled = new Set<string>();
  #selectList: SelectList;
  #maxVisible: number;
  #theme: SelectListTheme;

  onConfirm?: (selected: SelectItem[]) => void;
  onCancel?: () => void;

  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
    this.#items = items;
    this.#maxVisible = maxVisible;
    this.#theme = theme;
    this.#selectList = this.#buildList();
  }

  #buildList(): SelectList {
    const displayItems: SelectItem[] = this.#items.map((item) => ({
      value: item.value,
      label: `${this.#toggled.has(item.value) ? "[✓]" : "[ ]"} ${item.label}`,
      description: item.description,
    }));

    const list = new SelectList(displayItems, this.#maxVisible, this.#theme);
    // No onSelect — Enter confirms all, not single item
    list.onCancel = () => this.onCancel?.();
    return list;
  }

  #rebuild(preserveIndex: boolean): void {
    const currentItem = preserveIndex ? this.#selectList.getSelectedItem() : null;
    this.#selectList = this.#buildList();
    this.#selectList.onCancel = () => this.onCancel?.();
    if (currentItem) {
      const idx = this.#items.findIndex((i) => i.value === currentItem.value);
      if (idx >= 0) this.#selectList.setSelectedIndex(idx);
    }
  }

  render(width: number): string[] {
    return this.#selectList.render(width);
  }

  invalidate(): void {
    this.#selectList.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // Space → toggle current item
    if (data === " ") {
      const selected = this.#selectList.getSelectedItem();
      if (selected) {
        // Extract original value (label has [✓]/[ ] prefix)
        const originalItem = this.#items.find((i) =>
          selected.value === i.value
        );
        if (originalItem) {
          if (this.#toggled.has(originalItem.value)) {
            this.#toggled.delete(originalItem.value);
          } else {
            this.#toggled.add(originalItem.value);
          }
          this.#rebuild(true);
        }
      }
      return;
    }

    // Enter → confirm with all toggled items
    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.#items.filter((i) => this.#toggled.has(i.value));
      this.onConfirm?.(selected);
      return;
    }

    // Everything else → delegate to SelectList (arrows, escape, etc.)
    this.#selectList.handleInput(data);
  }
}
