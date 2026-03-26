import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SelectItem } from "@mariozechner/pi-tui";
import { checkboxOverlay, type CheckboxResult } from "../../shared/overlays.js";

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
          // Multi-select via shared checkbox overlay
          const checkboxItems: SelectItem[] = options.map((opt) => ({
            value: opt,
            label: opt,
          }));

          const result: CheckboxResult = await checkboxOverlay(ctx, params.question, checkboxItems, {
            overlayMode: true,
            hints: ["Space: toggle  Enter: confirm  Esc: cancel"],
          });

          answer = result.type === "selected" ? result.ids : [];
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
