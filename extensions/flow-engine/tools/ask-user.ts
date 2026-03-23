import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, Spacer, Text } from "@mariozechner/pi-tui";
import { CheckboxSelectList } from "../../shared/checkbox-select-list.js";

export function registerAskUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    description: "Ask the user a question with structured options. Use for decisions, confirmations, and freetext input.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask" }),
      type: Type.Union([
        Type.Literal("select"),
        Type.Literal("confirm"),
        Type.Literal("input"),
      ], { description: "Question type: select (pick from options), confirm (yes/no), input (freetext)" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Options for select type" })),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections" })),
      allowNotes: Type.Optional(Type.Boolean({ description: "Prompt for optional notes after selection" })),
      allowCustom: Type.Optional(Type.Boolean({ description: "Append 'Other (describe)' option" })),
      defaultValue: Type.Optional(Type.String({ description: "Default value for input type" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let answer: any;
      let notes: string | undefined;

      if (params.type === "confirm") {
        answer = await ctx.ui.confirm(params.question);
      } else if (params.type === "input") {
        answer = await ctx.ui.input(params.question, params.defaultValue || "");
      } else if (params.type === "select") {
        const options = [...(params.options || [])];
        if (params.allowCustom) options.push("Other (describe)");

        if (params.multiSelect) {
          // Multi-select via checkbox-toggle overlay
          const checkboxItems: SelectItem[] = options.map((opt) => ({
            value: opt,
            label: opt,
          }));

          answer = await new Promise<string[]>((resolve) => {
            ctx.ui.custom((tui: any, t: any, _kb: any, done: (val: string[]) => void) => {
              const checkbox = new CheckboxSelectList(checkboxItems, Math.min(checkboxItems.length, 12), {
                selectedPrefix: (text: string) => t.fg("accent", text),
                selectedText: (text: string) => t.fg("accent", text),
                description: (text: string) => t.fg("muted", text),
                scrollInfo: (text: string) => t.fg("dim", text),
                noMatch: (text: string) => t.fg("warning", text),
              });
              checkbox.onConfirm = (selected: SelectItem[]) => done(selected.map((s) => s.value));
              checkbox.onCancel = () => done([]);

              const container = new Container();
              container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
              container.addChild(new Text(t.fg("accent", ` ${params.question}`), 0, 0));
              container.addChild(new Spacer(1));
              container.addChild(checkbox as any);
              container.addChild(new Spacer(1));
              container.addChild(new Text(t.fg("dim", " Space: toggle  Enter: confirm  Esc: cancel"), 0, 0));
              container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));

              return {
                render: (w: number) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
                  checkbox.handleInput(data);
                  tui.requestRender();
                },
              };
            }, { overlay: true }).then(resolve);
          });
        } else {
          answer = await ctx.ui.select(params.question, options);
        }

        // Handle "Other (describe)" custom freetext
        if (answer === "Other (describe)") {
          answer = await ctx.ui.input("Describe:", "");
        }

        // Prompt for notes if allowed
        if (params.allowNotes) {
          const notesInput = await ctx.ui.input("Optional notes (press Enter to skip):", "");
          if (notesInput && notesInput.trim()) notes = notesInput.trim();
        }
      }

      const result = notes !== undefined ? { answer, notes } : { answer };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  });
}
