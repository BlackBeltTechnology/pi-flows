# DOX — extensions/shared

Files in this area. Purposes left for the agent to author.

| `checkbox-select-list.ts` | CheckboxSelectList class: multi-select over pi-tui SelectList; Space toggles [✓]/[ ], Enter fires onConfirm(selected: SelectItem[]), Esc onCancel; preserves cursor index. |
| `flow-widget.ts` | setFlowWidget(ui, key, content, options?) enforces one flow widget: FLOW_WIDGET_KEYS flow-dashboard/flow-summary, clears other keys, undefined removes; default placement aboveEditor. |
| `overlays.ts` | Shared bordered overlay helpers: selectOverlay, searchableOverlay, settingsOverlay, checkboxOverlay wrap pi-tui lists via ctx.ui.custom; option types + CheckboxResult {selected, action, cancelled}. |
| `searchable-select-list.ts` | SearchableSelectList class: Container(Input+Spacer+SelectList); lowercase substring filter over label/value/description; onSelect/onCancel; re-exports SelectItem + SearchableSelectListOptions. |
| `select-overlay.ts` | Backward-compatible shim: re-exports selectOverlay + type SelectItem from ./overlays.js. |
