import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerAskUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "ask_user",
    description:
      "Ask the user a question with structured options. Use for decisions, confirmations, and freetext input.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask" }),
      type: Type.Union(
        [
          Type.Literal("select"),
          Type.Literal("confirm"),
          Type.Literal("input"),
        ],
        {
          description:
            "Question type: select (pick from options), confirm (yes/no), input (freetext)",
        },
      ),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "Options for select type" }),
      ),
      multiSelect: Type.Optional(
        Type.Boolean({ description: "Allow multiple selections" }),
      ),
      allowCustom: Type.Optional(
        Type.Boolean({ description: "Append 'Other (describe)' option" }),
      ),
      defaultValue: Type.Optional(
        Type.String({ description: "Default value for input type" }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let answer: any;

      if (params.type === "confirm") {
        answer = await ctx.ui.confirm(params.question, "");
      } else if (params.type === "input") {
        answer = await ctx.ui.input(params.question, params.defaultValue || "");
      } else if (params.type === "select") {
        const options = [...(params.options || [])];
        if (params.allowCustom) options.push("Other (describe)");

        if (params.multiSelect) {
          // Multi-select via per-option confirm (works through ui-proxy for dashboard)
          const selected: string[] = [];
          for (const opt of options) {
            const yes = await ctx.ui.confirm(
              `${params.question}\n  Include "${opt}"?`,
              "",
            );
            if (yes) selected.push(opt);
          }
          answer = selected;
        } else {
          answer = await ctx.ui.select(params.question, options);
        }

        // Handle "Other (describe)" custom freetext
        if (answer === "Other (describe)") {
          answer = await ctx.ui.input("Describe:", "");
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ answer }) }],
        details: {},
      };
    },
  });
}
