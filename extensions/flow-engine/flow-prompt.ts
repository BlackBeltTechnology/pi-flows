// ---------------------------------------------------------------------------
// Flow Prompt — Prompt request/response infrastructure
//
// Provides `emitPromptAndAwait()` for the architect orchestrator and other
// flow pipelines to request user input without depending on ctx.ui.
//
// When the PromptBus is available (dashboard bridge connected), routes
// through the bus for unified TUI/dashboard handling.
// Falls back to legacy event-based system (flow:prompt-request/response)
// when no bus is available.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasPromptBus, promptBusRequest } from "./prompt-bus-access.js";

let promptCounter = 0;

export interface PromptOptions {
  pipeline: string;      // "architect-new" | "architect-edit" | "flow-run"
  type: "select" | "input" | "confirm";
  question: string;
  options?: string[];    // for select
  defaultValue?: string; // for input
}

export interface PromptRequest extends PromptOptions {
  id: string;
}

export interface PromptResponse {
  id: string;
  answer?: string;
  cancelled?: boolean;
}

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Emit a `flow:prompt-request` event and await the matching `flow:prompt-response`.
 *
 * The first adapter to respond wins. Late responses with the same `id` are ignored.
 * If no response arrives within the timeout, returns `{ cancelled: true }`.
 *
 * For architect pipelines (`architect-*`), also listens for `flow:architect-abort`
 * and resolves with `{ cancelled: true }` so abort works during the prompt phase.
 */
export function emitPromptAndAwait(
  pi: ExtensionAPI,
  options: PromptOptions,
): Promise<PromptResponse> {
  // Use PromptBus when available (dashboard bridge connected)
  if (hasPromptBus()) {
    return promptBusRequest({
      pipeline: options.pipeline,
      type: options.type as any,
      question: options.question,
      options: options.options,
      defaultValue: options.defaultValue,
    }).then(busResponse => ({
      id: busResponse.id,
      answer: busResponse.answer,
      cancelled: busResponse.cancelled,
    }));
  }

  // Legacy fallback: event-based prompt system
  const id = `prompt-${++promptCounter}-${Date.now()}`;

  return new Promise<PromptResponse>((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubs: Array<() => void> = [];

    function settle(response: PromptResponse) {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      for (const u of unsubs) u();
      resolve(response);
    }

    unsubs.push(pi.events.on("flow:prompt-response", (data: unknown) => {
      const response = data as PromptResponse;
      if (response.id !== id) return;
      settle(response);
    }));

    // For architect pipelines, also listen for abort events so that
    // aborting during the prompt phase (when architectAbort is null)
    // properly cancels the prompt instead of being a no-op.
    if (options.pipeline.startsWith("architect-")) {
      unsubs.push(pi.events.on("flow:architect-abort", () => {
        settle({ id, cancelled: true });
      }));
    }

    // Timeout: cancel if no response within the limit
    timer = setTimeout(() => {
      settle({ id, cancelled: true });
    }, PROMPT_TIMEOUT_MS);

    // Emit the request for adapters to pick up
    const request: PromptRequest = { id, ...options };
    pi.events.emit("flow:prompt-request", request);
  });
}
