import { Type } from "typebox";
import type { QuestionResult, QuestionSpec } from "../flow-mailbox.js";
import type { ItemRef } from "../types.js";

export const ASK_PARENT_TOOL_NAME = "ask_parent";
const MAX_TIMEOUT_S = 86400;

/** Text an agent gets when its question timed out without a `default`. */
export function noAnswerText(timeoutS: number): string {
  return `The parent did not answer within ${timeoutS}s. Decide yourself, state your assumption in your result, and continue.`;
}

type Ask = (spec: QuestionSpec, signal?: AbortSignal) => Promise<QuestionResult>;

const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

/** Argument problem, or null. */
export function askParentArgsProblem(p: {
  question?: unknown; options?: unknown; allowCustom?: unknown; timeout_s?: unknown; default?: unknown;
}): string | null {
  if (typeof p.question !== "string" || !p.question.trim()) return "question is required";
  if (p.timeout_s !== undefined) {
    const t = p.timeout_s;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_S) {
      return `timeout_s must be an integer from 1 to ${MAX_TIMEOUT_S}`;
    }
  }
  if (p.default !== undefined) {
    if (p.timeout_s === undefined) return "default needs timeout_s";
    const opts = Array.isArray(p.options) ? (p.options as string[]) : undefined;
    if (opts && !p.allowCustom && !opts.includes(String(p.default))) return `default must be one of the options: ${opts.join(", ")}`;
  }
  return null;
}

/**
 * Per-spawn `ask_parent` for a worker agent of a parent-attached run. Parks
 * the agent until the parent answers (no timeout unless asked).
 * See change: add-flow-parent-mailbox.
 */
export function makeAskParentTool(ask: Ask, where: { stepId: string; agent: string; item?: ItemRef }) {
  return {
    name: ASK_PARENT_TOOL_NAME,
    label: ASK_PARENT_TOOL_NAME,
    description:
      "Ask the parent session (the orchestrating model) a question when you need a decision you cannot make yourself. " +
      "Blocks until the parent answers. Optional `options` (with `multiSelect` / `allowCustom`), and `timeout_s` + `default`: " +
      "on timeout you get `default` back. Ask only when truly blocked; otherwise decide and state your assumption.",
    parameters: Type.Object({
      question: Type.String({ description: "One clear question with the options you see." }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Allowed answers" })),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow several options (answer is a list)" })),
      allowCustom: Type.Optional(Type.Boolean({ description: "Allow a free-text answer besides the options" })),
      timeout_s: Type.Optional(Type.Number({ description: "Seconds to wait before returning `default` (1-86400)" })),
      default: Type.Optional(Type.String({ description: "Returned on timeout (requires timeout_s)" })),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      const problem = askParentArgsProblem(params ?? {});
      if (problem) return err(`ask_parent: ${problem}`);
      const r = await ask({
        ...where,
        kind: "agent",
        question: params.question.trim(),
        ...(params.options ? { options: params.options } : {}),
        ...(params.multiSelect ? { multiSelect: true } : {}),
        ...(params.allowCustom ? { allowCustom: true } : {}),
        ...(params.timeout_s ? { timeoutS: params.timeout_s } : {}),
        ...(params.default !== undefined ? { default: params.default } : {}),
      }, signal);
      if (r.via === "cancel") return err("ask_parent: the question was closed (the run or step stopped).");
      if (r.via === "timeout") {
        const text = r.answer !== undefined ? (Array.isArray(r.answer) ? r.answer.join(", ") : r.answer) : noAnswerText(params.timeout_s);
        return ok(text, { timedOut: true });
      }
      const answer = Array.isArray(r.answer) ? r.answer.join(", ") : r.answer;
      return ok(r.notes ? `${answer}\n\nNotes: ${r.notes}` : answer);
    },
  };
}
