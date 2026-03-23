// ---------------------------------------------------------------------------
// select-overlay — Show a SelectList inline (replaces editor at prompt line)
//
// Replaces ctx.ui.select() with a richer SelectList that shows descriptions.
// ---------------------------------------------------------------------------

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";

export { type SelectItem } from "@mariozechner/pi-tui";

/**
 * Show a SelectList overlay and return the selected item's value, or null on cancel.
 */
export async function selectOverlay(
  ctx: any,
  title: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom((tui: any, t: any, _kb: any, done: (val: string | null) => void) => {
    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text: string) => t.fg("accent", text),
      selectedText: (text: string) => t.fg("accent", text),
      description: (text: string) => t.fg("muted", text),
      scrollInfo: (text: string) => t.fg("dim", text),
      noMatch: (text: string) => t.fg("warning", text),
    });
    selectList.onSelect = (item: SelectItem) => done(item.value);
    selectList.onCancel = () => done(null);

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
    container.addChild(new Text(t.fg("accent", t.bold(` ${title}`)), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Backspace navigates back (same as Esc cancel)
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
