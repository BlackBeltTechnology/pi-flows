import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeQuestion, renderMail, type FlowMailbox, type ReplyInput, type ReplyOutcome } from "../flow-mailbox.js";
import { projectRuns } from "../flow-persist.js";

const NO_RUN = "No parent-attached run is active (start one with flow_run; runs started by other hosts are not yours to control).";

const text = (t: string, details: Record<string, unknown> = {}, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details,
  ...(isError ? { isError: true } : {}),
});

/**
 * `flow_control` — the main session drives its parent-attached run:
 * wait / reply / status / cancel. Not the read-only run-state seam (that is
 * `flow_results runs`); `status` only reads it. See change: add-flow-parent-mailbox.
 */
export function registerFlowControlTool(
  pi: ExtensionAPI,
  deps: {
    mailbox: FlowMailbox;
    /** Active run, when it is parent-attached. */
    attachedRun: () => { runId: string; flowName: string } | null;
    cancel: () => void;
    getSessionEntries: () => unknown;
  },
): void {
  pi.registerTool({
    name: "flow_control",
    label: "flow_control",
    description:
      "Drive the flow run you started with flow_run. Actions: " +
      "wait {timeout_s?} — block until a new question or the run end (default 300 s, max 600 s); " +
      "reply {question_id, answer, notes?, decide?} or {replies:[...]} — answer questions (answer may be a list for multi-select; decide:true delegates a fork to its decider); " +
      "status — run, node statuses, open questions; cancel — stop the run.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("wait"), Type.Literal("reply"), Type.Literal("status"), Type.Literal("cancel")]),
      timeout_s: Type.Optional(Type.Number()),
      question_id: Type.Optional(Type.String()),
      answer: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      notes: Type.Optional(Type.String()),
      decide: Type.Optional(Type.Boolean()),
      replies: Type.Optional(Type.Array(Type.Object({
        question_id: Type.String(),
        answer: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
        notes: Type.Optional(Type.String()),
        decide: Type.Optional(Type.Boolean()),
      }))),
    }),
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      const { mailbox } = deps;
      const run = deps.attachedRun();
      switch (params.action) {
        case "wait": {
          const r = await mailbox.wait({ timeoutS: params.timeout_s, signal });
          if (r.nothingToWait) return text("Nothing to wait for: no parent-attached run is active and nothing is unreported.", { nothingToWait: true, questions: [] });
          const lines: string[] = [];
          if (r.questions.length || r.outcome) lines.push(renderMail(r.questions, r.outcome));
          if (r.timedOut) lines.push("Wait timed out; the run keeps going.");
          if (r.aborted) lines.push("Wait stopped.");
          if (r.busy) lines.push("Another flow_control wait is already blocking; use that one.");
          const stillOpen = r.open.filter((q) => !r.questions.some((x) => x.question_id === q.question_id));
          if (stillOpen.length) lines.push(`Still open (already shown):\n${stillOpen.map(describeQuestion).join("\n")}`);
          return text(lines.join("\n\n") || "No news.", {
            questions: r.questions,
            ...(r.outcome ? { outcome: r.outcome } : {}),
            open: r.open,
            ...(r.timedOut ? { timedOut: true } : {}),
            ...(r.aborted ? { aborted: true } : {}),
            ...(r.busy ? { busy: true } : {}),
          });
        }
        case "reply": {
          const inputs: ReplyInput[] = Array.isArray(params.replies)
            ? params.replies
            : params.question_id
              ? [{ question_id: params.question_id, answer: params.answer, notes: params.notes, decide: params.decide }]
              : [];
          if (inputs.length === 0) return text("reply needs question_id (+ answer or decide) or replies:[...]", {}, true);
          const outcomes: ReplyOutcome[] = inputs.map((i) => mailbox.reply(i));
          const summary = outcomes.map((o) =>
            o.outcome === "invalid" ? `${o.question_id}: invalid — ${o.reason}` : `${o.question_id}: ${o.outcome}`,
          ).join("\n");
          return text(summary, { outcomes });
        }
        case "status": {
          if (!run) return text(NO_RUN, { questions: [] });
          const projected = projectRuns(deps.getSessionEntries()).filter((r) => r.flowRunId === run.runId);
          const nodes = projected[projected.length - 1]?.nodes ?? [];
          const questions = mailbox.open().filter((q) => q.runId === run.runId);
          const lines = [
            `Run ${run.runId} (${run.flowName})`,
            ...nodes.map((n) => `- ${n.stepId}: ${n.status}${n.resultStatus ? ` (${n.resultStatus})` : ""}`),
            questions.length ? `Open questions:\n${questions.map(describeQuestion).join("\n")}` : "No open questions.",
          ];
          return text(lines.join("\n"), { runId: run.runId, flowName: run.flowName, nodes, questions });
        }
        case "cancel": {
          if (!run) return text(NO_RUN, {});
          deps.cancel();
          return text(`Cancelling run ${run.runId}; its open questions are closed.`, { runId: run.runId });
        }
        default:
          return text(`unknown action: ${params.action}`, {}, true);
      }
    },
  } as any);
}
