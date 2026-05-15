/**
 * ArchitectUIAdapter — Claims architect-* pipeline prompts with custom
 * widget-bar components for the dashboard client.
 *
 * Non-architect prompts are skipped (returns null), letting the default
 * dashboard adapter handle them as generic dialogs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Re-declare interfaces (same as tui-prompt-adapter.ts)
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

export class ArchitectUIAdapter implements PromptAdapter {
  readonly name = "architect-widget";

  private claimedPrompts = new Set<string>();

  onRequest(prompt: PromptRequest): PromptClaim | null {
    if (!prompt.pipeline.startsWith("architect-")) return null;

    this.claimedPrompts.add(prompt.id);
    return {
      component: {
        type: "architect-prompt",
        props: {
          id: prompt.id,
          question: prompt.question,
          promptType: prompt.type,
          options: prompt.options,
          defaultValue: prompt.defaultValue,
        },
      },
      placement: "widget-bar",
    };
  }

  onResponse(response: PromptResponse): void {
    this.claimedPrompts.delete(response.id);
  }

  onCancel(id: string): void {
    this.claimedPrompts.delete(id);
  }
}

/**
 * Create and register an ArchitectUIAdapter via pi.events.
 */
export function registerArchitectUIAdapter(pi: ExtensionAPI): ArchitectUIAdapter {
  const adapter = new ArchitectUIAdapter();
  pi.events.emit("prompt:register-adapter", adapter);
  return adapter;
}
