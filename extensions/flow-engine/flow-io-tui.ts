// ---------------------------------------------------------------------------
// Flow I/O Adapter for detached runs
//
// Flows never prompt a human. A parent-attached run sends its questions to the
// parent session through the mailbox (flow-mailbox.ts); a detached run uses
// this adapter: forks take their first option, extension prompts resolve as
// cancelled. The optional `ui` only carries engine notices.
// See change: add-flow-parent-mailbox (the former TUI dialog adapter and its
// AskUserQueue were removed).
// ---------------------------------------------------------------------------

import type { FlowIOAdapter, AskUserResult } from "./flow-io.js";

export class HeadlessFlowIOAdapter implements FlowIOAdapter {
  constructor(private ui?: { notify?: (message: string, level?: any) => void }) {}

  async askUser(
    _question: string,
    _type: "select" | "confirm" | "input" | "multiselect",
    options?: string[],
  ): Promise<AskUserResult> {
    return { answer: options?.[0] || "" };
  }

  handleExtensionUIRequest(
    _agentName: string,
    request: { id: string; method: string; [key: string]: any },
    respond: (response: any) => void,
  ): void {
    // No human dialogs — cancel all extension UI requests
    respond({ id: request.id, cancelled: true });
  }

  notify(message: string): void {
    this.ui?.notify?.(message, "info");
  }
}
