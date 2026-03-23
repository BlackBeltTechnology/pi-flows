// ---------------------------------------------------------------------------
// SearchableSelectList — Input + SelectList composite with substring filtering
//
// Usage:
//   import { SearchableSelectList } from "../shared/searchable-select-list.js";
//   const list = new SearchableSelectList(items, 10, theme);
//   list.onSelect = (item) => done(item.value);
//   list.onCancel = () => done(null);
// ---------------------------------------------------------------------------

import {
  Container,
  Input,
  SelectList,
  Spacer,
  type SelectItem,
  type SelectListTheme,
  getKeybindings,
} from "@mariozechner/pi-tui";

export { type SelectItem } from "@mariozechner/pi-tui";

export interface SearchableSelectListOptions {
  /** Placeholder text shown when input is empty */
  placeholder?: string;
}

export class SearchableSelectList {
  #container = new Container();
  #input = new Input();
  #selectList: SelectList;
  #allItems: SelectItem[];
  #maxVisible: number;
  #theme: SelectListTheme;
  #filterValue = "";

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(
    items: SelectItem[],
    maxVisible: number,
    theme: SelectListTheme,
    _options?: SearchableSelectListOptions,
  ) {
    this.#allItems = items;
    this.#maxVisible = maxVisible;
    this.#theme = theme;

    this.#selectList = new SelectList(items, maxVisible, theme);
    this.#selectList.onSelect = (item) => this.onSelect?.(item);
    this.#selectList.onCancel = () => this.onCancel?.();

    this.#input.focused = true;

    this.#container.addChild(this.#input);
    this.#container.addChild(new Spacer(1));
    this.#container.addChild(this.#selectList);
  }

  render(width: number): string[] {
    return this.#container.render(width);
  }

  invalidate(): void {
    this.#container.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // Navigation keys → forward to SelectList
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.pageUp") ||
      kb.matches(data, "tui.select.pageDown")
    ) {
      this.#selectList.handleInput(data);
      return;
    }

    // Enter → forward to SelectList (triggers onSelect)
    if (kb.matches(data, "tui.select.confirm")) {
      this.#selectList.handleInput(data);
      return;
    }

    // Escape → forward to SelectList (triggers onCancel)
    if (kb.matches(data, "tui.select.cancel")) {
      this.#selectList.handleInput(data);
      return;
    }

    // Everything else → Input (search text)
    this.#input.handleInput(data);
    const newFilter = this.#input.getValue();
    if (newFilter !== this.#filterValue) {
      this.#filterValue = newFilter;
      this.#rebuildList();
    }
  }

  #rebuildList(): void {
    const query = this.#filterValue.toLowerCase();
    const filtered = query
      ? this.#allItems.filter(
          (item) =>
            item.label.toLowerCase().includes(query) ||
            item.value.toLowerCase().includes(query) ||
            (item.description?.toLowerCase().includes(query) ?? false),
        )
      : this.#allItems;

    // Replace the SelectList with a new one containing filtered items
    this.#container.removeChild(this.#selectList);
    this.#selectList = new SelectList(filtered, this.#maxVisible, this.#theme);
    this.#selectList.onSelect = (item) => this.onSelect?.(item);
    this.#selectList.onCancel = () => this.onCancel?.();
    this.#container.addChild(this.#selectList);
  }
}
