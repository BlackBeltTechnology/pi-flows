/**
 * TuiPromptAdapter — Presents prompts in the terminal TUI via original
 * (unproxied) ctx.ui methods. Registers with the PromptBus via pi.events.
 *
 * - Captures original ctx.ui refs from "prompt:ctx-originals" event
 * - Shows TUI dialogs with AbortController for cancellation
 * - Responds via promptBus.respond() when user answers in TUI
 * - Aborts TUI dialogs when another adapter answers first
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Re-declare interfaces to avoid cross-package import from pi-agent-dashboard.
// These must stay in sync with prompt-bus.ts.
interface PromptRequest {
  id: string;
  pipeline: string;
  type: "select" | "input" | "confirm" | "editor" | "multiselect";
  question: string;
  options?: string[];
  defaultValue?: string;
  metadata?: Record<string, unknown>;
}

interface PromptResponse {
  id: string;
  answer?: string;
  cancelled?: boolean;
  source: string;
}

interface PromptClaim {
  component?: { type: string; props: Record<string, unknown> };
  placement?: "widget-bar" | "inline" | "overlay";
}

interface PromptAdapter {
  name: string;
  onRequest(prompt: PromptRequest): PromptClaim | null | undefined | void;
  onResponse(response: PromptResponse): void;
  onCancel(id: string): void;
}

/** Respond callback — set after registration to bridge back to PromptBus */
type RespondFn = (response: PromptResponse) => void;

/** Handler for architect-pipeline prompts rendered inline in the architect widget */
export type ArchitectPromptHandler = (
  id: string,
  type: "select" | "input",
  question: string,
  options: string[] | undefined,
  signal: AbortSignal,
) => Promise<string | undefined>;

export class TuiPromptAdapter implements PromptAdapter {
  readonly name = "tui";

  private originals: {
    select: (q: string, opts: string[], extra?: any) => Promise<string | undefined>;
    input: (q: string, placeholder?: string, extra?: any) => Promise<string | undefined>;
    confirm: (q: string, msg: string, extra?: any) => Promise<boolean>;
    editor?: (q: string, prefill?: string, extra?: any) => Promise<string | undefined>;
  } | null = null;

  private activeControllers = new Map<string, AbortController>();
  private respondFn: RespondFn | null = null;
  private architectHandler: ArchitectPromptHandler | null = null;

  /**
   * Set the respond callback. Called by the registration code after
   * the adapter is registered with the bus.
   */
  setRespond(fn: RespondFn): void {
    this.respondFn = fn;
  }

  /**
   * Set handler for architect-pipeline prompts (renders inline in architect widget).
   */
  setArchitectHandler(handler: ArchitectPromptHandler): void {
    this.architectHandler = handler;
  }

  /**
   * Capture original ctx.ui methods from the "prompt:ctx-originals" event.
   */
  captureOriginals(originals: Record<string, any>): void {
    this.originals = {
      select: originals.select,
      input: originals.input,
      confirm: originals.confirm,
      editor: originals.editor,
    };
  }

  onRequest(prompt: PromptRequest): PromptClaim | null {
    if (!this.originals) return null;

    const ac = new AbortController();
    this.activeControllers.set(prompt.id, ac);

    // Route architect-pipeline prompts to the widget handler
    const isArchitect = prompt.pipeline.startsWith("architect-") && this.architectHandler;

    const present = async () => {
      try {
        let answer: string | boolean | undefined;

        if (isArchitect && (prompt.type === "select" || prompt.type === "input")) {
          answer = await this.architectHandler!(prompt.id, prompt.type, prompt.question, prompt.options, ac.signal);
        } else if (prompt.type === "select" && prompt.options) {
          answer = await this.originals!.select(prompt.question, prompt.options, { signal: ac.signal });
        } else if (prompt.type === "input") {
          answer = await this.originals!.input(prompt.question, prompt.defaultValue || "", { signal: ac.signal });
        } else if (prompt.type === "confirm") {
          answer = await this.originals!.confirm(prompt.question, "", { signal: ac.signal });
        } else if (prompt.type === "editor" && this.originals!.editor) {
          answer = await this.originals!.editor(prompt.question, prompt.defaultValue || "", { signal: ac.signal });
        } else {
          return;
        }

        if (!ac.signal.aborted && this.respondFn) {
          const answerStr = typeof answer === "boolean" ? (answer ? "true" : "false") : answer;
          this.respondFn({
            id: prompt.id,
            answer: answerStr ?? undefined,
            cancelled: answerStr == null,
            source: "tui",
          });
        }
      } catch {
        // Aborted or error — don't respond
        if (!ac.signal.aborted && this.respondFn) {
          this.respondFn({ id: prompt.id, cancelled: true, source: "tui" });
        }
      } finally {
        this.activeControllers.delete(prompt.id);
      }
    };

    present();
    return {}; // Claim without component (TUI-only)
  }

  onResponse(response: PromptResponse): void {
    if (response.source !== "tui") {
      const ac = this.activeControllers.get(response.id);
      if (ac) {
        ac.abort();
        this.activeControllers.delete(response.id);
      }
    }
  }

  onCancel(id: string): void {
    const ac = this.activeControllers.get(id);
    if (ac) {
      ac.abort();
      this.activeControllers.delete(id);
    }
  }
}

/**
 * Create and register a TuiPromptAdapter via pi.events.
 * Call this from flow-engine activate() when ctx.hasUI is true.
 */
export function registerTuiPromptAdapter(pi: ExtensionAPI): TuiPromptAdapter {
  const adapter = new TuiPromptAdapter();

  // Listen for original ctx.ui methods from the dashboard bridge
  pi.events.on("prompt:ctx-originals", (originals: any) => {
    adapter.captureOriginals(originals);
  });

  // Register with the PromptBus (dashboard bridge listens for this).
  // The bridge injects the respond function via adapter.setRespond()
  // after registration, so the adapter can talk back to the bus.
  pi.events.emit("prompt:register-adapter", adapter);

  return adapter;
}
