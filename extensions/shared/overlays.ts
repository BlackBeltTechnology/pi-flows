// ---------------------------------------------------------------------------
// Shared Overlay Helpers
//
// Standardized overlay functions for all pi-flows extensions.
// Each wraps a pi-tui component in a consistent bordered frame.
//
// Usage:
//   import { selectOverlay, searchableOverlay, checkboxOverlay, settingsOverlay } from "./shared/overlays.js";
// ---------------------------------------------------------------------------

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  getKeybindings,
} from "@mariozechner/pi-tui";
import { SearchableSelectList } from "./searchable-select-list.js";
import { CheckboxSelectList } from "./checkbox-select-list.js";

export { type SelectItem } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Internal: shared frame builder
// ---------------------------------------------------------------------------

function overlayFrame(
  t: any,
  title: string,
  inner: any,
  hints: string[],
): Container {
  const container = new Container();
  container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
  container.addChild(new Text(t.fg("accent", t.bold(` ${title}`)), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(inner);
  container.addChild(new Spacer(1));
  for (const hint of hints) {
    container.addChild(new Text(t.fg("dim", ` ${hint}`), 0, 0));
  }
  container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
  return container;
}

// ---------------------------------------------------------------------------
// Internal: shared SelectList theme
// ---------------------------------------------------------------------------

function listTheme(t: any): SelectListTheme {
  return {
    selectedPrefix: (text: string) => t.fg("accent", text),
    selectedText: (text: string) => t.fg("accent", text),
    description: (text: string) => t.fg("muted", text),
    scrollInfo: (text: string) => t.fg("dim", text),
    noMatch: (text: string) => t.fg("warning", text),
  };
}

// ---------------------------------------------------------------------------
// Internal: shared SettingsList theme
// ---------------------------------------------------------------------------

function settingsTheme(t: any): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) => selected ? t.fg("accent", text) : text,
    value: (text: string, selected: boolean) => selected ? t.fg("accent", text) : t.fg("muted", text),
    description: (text: string) => t.fg("dim", text),
    cursor: t.fg("accent", "→ "),
    hint: (text: string) => t.fg("dim", text),
  };
}

// ---------------------------------------------------------------------------
// selectOverlay — bordered SelectList
// ---------------------------------------------------------------------------

/**
 * Show a SelectList overlay and return the selected item's value, or null on cancel.
 */
export async function selectOverlay(
  ctx: any,
  title: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom((tui: any, t: any, _kb: any, done: (val: string | null) => void) => {
    const selectList = new SelectList(items, Math.min(items.length, 12), listTheme(t));
    selectList.onSelect = (item: SelectItem) => done(item.value);
    selectList.onCancel = () => done(null);

    const container = overlayFrame(t, title, selectList, []);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "\x7f" || data === "\b") {
          done(null);
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// searchableOverlay — bordered SearchableSelectList
// ---------------------------------------------------------------------------

export interface SearchableOverlayOptions {
  maxVisible?: number;
  hints?: string[];
}

/**
 * Show a SearchableSelectList overlay and return the selected item's value, or null on cancel.
 */
export async function searchableOverlay(
  ctx: any,
  title: string,
  items: SelectItem[],
  opts?: SearchableOverlayOptions,
): Promise<string | null> {
  const maxVisible = opts?.maxVisible ?? 12;
  const hints = opts?.hints ?? ["Enter: select  Esc: close"];

  return ctx.ui.custom((tui: any, t: any, _kb: any, done: (val: string | null) => void) => {
    const searchable = new SearchableSelectList(items, maxVisible, listTheme(t));
    searchable.onSelect = (item: SelectItem) => done(item.value);
    searchable.onCancel = () => done(null);

    const container = overlayFrame(t, title, searchable, hints);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        searchable.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// settingsOverlay — bordered SettingsList
// ---------------------------------------------------------------------------

export interface SettingsOverlayOptions {
  hints?: string[];
  maxVisible?: number;
  /**
   * When provided, called with (t, listTheme) to build items dynamically.
   * This allows submenus to use the theme accessor `t` for styling.
   * When set, the `items` parameter to settingsOverlay is ignored.
   */
  createItems?: (t: any, theme: SelectListTheme) => SettingItem[];
}

/**
 * Show a SettingsList overlay. Calls onChange when values change. Resolves on close (Esc).
 * Pass items directly, or use opts.createItems(t, listTheme) for submenus needing theme access.
 */
export async function settingsOverlay(
  ctx: any,
  title: string,
  items: SettingItem[],
  onChange: (id: string, newValue: string) => void,
  opts?: SettingsOverlayOptions,
): Promise<void> {
  const hints = opts?.hints ?? ["Enter/Space: change  Esc: close"];

  return ctx.ui.custom((tui: any, t: any, _kb: any, done: () => void) => {
    const resolvedItems = opts?.createItems ? opts.createItems(t, listTheme(t)) : items;
    const maxVisible = opts?.maxVisible ?? Math.min(resolvedItems.length + 2, 12);

    const list = new SettingsList(
      resolvedItems,
      maxVisible,
      settingsTheme(t),
      onChange,
      () => done(),
    );

    const container = overlayFrame(t, title, list, hints);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Backspace at top level closes (same as Esc)
        if ((data === "\x7f" || data === "\b") && !(list as any).submenuComponent) {
          done();
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// checkboxOverlay — bordered CheckboxSelectList
// ---------------------------------------------------------------------------

export type CheckboxResult =
  | { type: "selected"; ids: string[] }
  | { type: "action"; value: string }
  | { type: "cancelled" };

export interface CheckboxOverlayOptions {
  preSelected?: string[];
  actionItems?: SelectItem[];
  allToggle?: boolean;
  overlayMode?: boolean;
  hints?: string[];
  maxVisible?: number;
}

/**
 * Show a CheckboxSelectList overlay with optional action items and all-toggle.
 */
export async function checkboxOverlay(
  ctx: any,
  title: string,
  items: SelectItem[],
  opts?: CheckboxOverlayOptions,
): Promise<CheckboxResult> {
  const preSelected = opts?.preSelected;
  const actionItems = opts?.actionItems ?? [];
  const allToggle = opts?.allToggle ?? false;
  const overlayMode = opts?.overlayMode ?? false;
  const hints = opts?.hints ?? ["Space: toggle  Enter: confirm  Esc: cancel"];
  const maxVisible = opts?.maxVisible ?? 12;

  // Action item values for identification
  const actionValues = new Set(actionItems.map((a) => a.value));
  const ALL_VALUE = "__all_toggle__";

  const customFn = (tui: any, t: any, _kb: any, done: (val: CheckboxResult) => void) => {
    // Build the combined items list for CheckboxSelectList:
    // 1. allToggle item (synthetic)
    // 2. actionItems (non-toggleable)
    // 3. regular items (toggleable)
    //
    // We manage allToggle and actionItems outside CheckboxSelectList
    // by intercepting Space/Enter on those items.

    const regularItems = items;
    const allItems: SelectItem[] = [];

    if (allToggle) {
      allItems.push({ value: ALL_VALUE, label: "All", description: "Toggle all items" });
    }
    for (const a of actionItems) {
      allItems.push(a);
    }
    for (const item of regularItems) {
      allItems.push(item);
    }

    // Track toggle state separately (CheckboxSelectList manages its own, but we
    // need to intercept for allToggle and actionItems)
    const toggled = new Set<string>(preSelected ?? []);
    const isAllChecked = () => regularItems.every((i) => toggled.has(i.value));

    // Build display items with prefixes
    const buildDisplayItems = (): SelectItem[] => {
      const display: SelectItem[] = [];
      if (allToggle) {
        const checked = isAllChecked();
        display.push({
          value: ALL_VALUE,
          label: `${checked ? "[✓]" : "[ ]"} All`,
          description: "Toggle all items",
        });
      }
      for (const a of actionItems) {
        display.push({ value: a.value, label: `    ${a.label}`, description: a.description });
      }
      for (const item of regularItems) {
        const checked = toggled.has(item.value);
        display.push({
          value: item.value,
          label: `${checked ? "[✓]" : "[ ]"} ${item.label}`,
          description: item.description,
        });
      }
      return display;
    };

    let displayItems = buildDisplayItems();
    let selectList = new SelectList(displayItems, maxVisible, listTheme(t));
    selectList.onCancel = () => done({ type: "cancelled" });

    const rebuild = () => {
      const currentItem = selectList.getSelectedItem();
      displayItems = buildDisplayItems();
      selectList = new SelectList(displayItems, maxVisible, listTheme(t));
      selectList.onCancel = () => done({ type: "cancelled" });
      if (currentItem) {
        const idx = displayItems.findIndex((i) => i.value === currentItem.value);
        if (idx >= 0) selectList.setSelectedIndex(idx);
      }
      // Rebuild the frame container
      container.clear();
      overlayFrameInto(container, t, title, selectList, hints);
    };

    const container = new Container();
    overlayFrameInto(container, t, title, selectList, hints);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const kb = getKeybindings();
        const selected = selectList.getSelectedItem();

        // Space → toggle (only for regular items and allToggle)
        if (data === " " && selected) {
          if (selected.value === ALL_VALUE) {
            const allChecked = isAllChecked();
            if (allChecked) {
              toggled.clear();
            } else {
              for (const item of regularItems) toggled.add(item.value);
            }
            rebuild();
            tui.requestRender();
            return;
          }
          if (actionValues.has(selected.value)) {
            // No toggle for action items
            return;
          }
          // Regular item toggle
          if (toggled.has(selected.value)) {
            toggled.delete(selected.value);
          } else {
            toggled.add(selected.value);
          }
          rebuild();
          tui.requestRender();
          return;
        }

        // Enter → confirm or trigger action
        if (kb.matches(data, "tui.select.confirm") && selected) {
          if (selected.value === ALL_VALUE) {
            // Same as Space on All
            const allChecked = isAllChecked();
            if (allChecked) {
              toggled.clear();
            } else {
              for (const item of regularItems) toggled.add(item.value);
            }
            rebuild();
            tui.requestRender();
            return;
          }
          if (actionValues.has(selected.value)) {
            done({ type: "action", value: selected.value });
            return;
          }
          // Enter on regular item = confirm selection
          done({ type: "selected", ids: [...toggled] });
          return;
        }

        // Everything else → delegate to SelectList
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  };

  if (overlayMode) {
    return ctx.ui.custom(customFn, { overlay: true });
  }
  return ctx.ui.custom(customFn);
}

// ---------------------------------------------------------------------------
// Internal: overlayFrameInto — populate a container with frame children
// ---------------------------------------------------------------------------

function overlayFrameInto(
  container: Container,
  t: any,
  title: string,
  inner: any,
  hints: string[],
): void {
  container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
  container.addChild(new Text(t.fg("accent", t.bold(` ${title}`)), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(inner);
  container.addChild(new Spacer(1));
  for (const hint of hints) {
    container.addChild(new Text(t.fg("dim", ` ${hint}`), 0, 0));
  }
  container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
}

// ---------------------------------------------------------------------------
// Utility: text input submenu for SettingsList
// ---------------------------------------------------------------------------

/**
 * Create a text-input submenu factory for use with SettingsList items.
 * Returns a submenu function that shows an inline Input component.
 */
export function textInputSubmenu(placeholder: string) {
  return (_currentValue: string, submenuDone: (val?: string) => void) => {
    const input = new Input();
    input.focused = true;
    const kb = getKeybindings();
    return {
      render: (w: number) => {
        const lines = input.render(w);
        lines.push(`  ${placeholder} · Enter: confirm · Esc: cancel`);
        return lines;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (kb.matches(data, "tui.select.confirm")) {
          const val = input.getValue().trim();
          if (val) submenuDone(val);
          else submenuDone(undefined);
        } else if (kb.matches(data, "tui.select.cancel")) {
          submenuDone(undefined);
        } else {
          input.handleInput(data);
        }
      },
    };
  };
}
