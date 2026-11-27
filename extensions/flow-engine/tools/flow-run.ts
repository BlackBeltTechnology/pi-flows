import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowConfig } from "../types.js";

export type DispatchOutcome = { runId: string } | { rejected: string };

/**
 * `flow_run` — the main session starts a parent-attached flow run through the
 * shared `flow:run` dispatch path. See change: add-flow-parent-mailbox.
 */
export function registerFlowRunTool(
  pi: ExtensionAPI,
  deps: {
    getFlow: (name: string) => FlowConfig | undefined;
    dispatch: (flowName: string, opts: { task?: string; flowInput?: Record<string, unknown>; notifyParent: boolean }) => Promise<DispatchOutcome>;
  },
): void {
  pi.registerTool({
    name: "flow_run",
    label: "flow_run",
    description:
      "Start a flow in the background as its orchestrator. Returns the runId at once. " +
      "Questions from the flow's agents and forks come back to you (pushed as a message, or via flow_control wait); " +
      "answer them with flow_control reply, escalating to the user with ask_user when you cannot decide. " +
      "Use flow_control wait to wait for questions or the end (required in print mode, where no later turn may follow).",
    parameters: Type.Object({
      flow: Type.String({ description: "Flow command name, e.g. \"batch:apply\"" }),
      task: Type.Optional(Type.String({ description: "Task text for the flow" })),
      inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Typed flow inputs" })),
    }),
    execute: async (_toolCallId: string, params: any) => {
      const flow = deps.getFlow(params.flow);
      if (flow?.task_required && !String(params.task ?? "").trim()) {
        return {
          content: [{ type: "text" as const, text: `flow_run: flow "${params.flow}" requires a task (task_required).` }],
          details: {},
          isError: true,
        };
      }
      const out = await deps.dispatch(params.flow, {
        ...(params.task !== undefined ? { task: params.task } : {}),
        ...(params.inputs !== undefined ? { flowInput: params.inputs } : {}),
        notifyParent: true,
      });
      if ("rejected" in out) {
        return { content: [{ type: "text" as const, text: out.rejected }], details: { rejected: true }, isError: true };
      }
      return {
        content: [{ type: "text" as const, text: `Started ${params.flow} (run ${out.runId}). Questions and the end will reach you; use flow_control wait/reply/status/cancel.` }],
        details: { runId: out.runId },
      };
    },
  } as any);
}
