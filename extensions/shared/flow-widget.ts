// ---------------------------------------------------------------------------
// flow-widget — Centralized flow widget management
//
// All flow widgets render at "aboveEditor" placement.  Only ONE flow widget
// should be visible at a time.  This helper ensures that setting any flow
// widget automatically clears ALL other flow widget keys first, preventing
// visual artifacts where parts of a previous widget remain on screen.
// ---------------------------------------------------------------------------

/** All widget keys managed by the flow system. */
const FLOW_WIDGET_KEYS = ["flow-dashboard", "flow-summary"] as const;

export type FlowWidgetKey = (typeof FLOW_WIDGET_KEYS)[number];

/**
 * Set a flow widget, automatically clearing all OTHER flow widgets at the same
 * placement first.  This prevents visual artifacts from stale widget remnants.
 *
 * When `content` is `undefined` the widget identified by `key` is removed and
 * no other widgets are touched (simple clear).
 *
 * Overlay-only widgets (opened via `ctx.ui.custom({ overlay: true })`) are not
 * affected — only `setWidget`-based widgets are managed here.
 */
export function setFlowWidget(
  ui: { setWidget(key: string, content: any, options?: any): void },
  key: FlowWidgetKey,
  content: any,
  options?: { placement?: string },
): void {
  if (content === undefined) {
    // Simple removal — don't touch other keys.
    ui.setWidget(key, undefined);
    return;
  }

  // Clear ALL other flow widgets before setting the new one.
  for (const k of FLOW_WIDGET_KEYS) {
    if (k !== key) {
      ui.setWidget(k, undefined);
    }
  }

  ui.setWidget(key, content, options ?? { placement: "aboveEditor" });
}
