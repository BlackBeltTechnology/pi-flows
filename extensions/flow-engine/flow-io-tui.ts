// ---------------------------------------------------------------------------
// TUI Flow I/O Adapter
//
// Implements FlowIOAdapter using TUI widgets. Contains the AskUserQueue
// and all askUser TUI logic (checkbox overlay, select with branch labels,
// auto-decide injection, notes prompt, etc.)
// ---------------------------------------------------------------------------

import type { FlowIOAdapter, AskUserExtra, AskUserResult } from "./flow-io.js";
import type { SelectItem } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { CheckboxSelectList } from "../shared/checkbox-select-list.js";
import { FlowCancelledError } from "./flow-execution.js";
import { isAutonomousMode, setAutonomousMode } from "../provider-register.js";

// ---- Ask-user bridge queue ------------------------------------------------

interface AskUserQueueEntry {
  requestId: string;
  agentName: string;
  request: any;
  respond: (response: any) => void;
}

class AskUserQueue {
  private queue: AskUserQueueEntry[] = [];
  private processing = false;
  private ui: any = null;
  private isOverlayOpen: () => boolean = () => false;
  private aborted = false;

  setUI(ui: any, isOverlayOpen: () => boolean) {
    this.ui = ui;
    this.isOverlayOpen = isOverlayOpen;
  }

  enqueue(entry: AskUserQueueEntry) {
    if (this.aborted) {
      entry.respond({ id: entry.requestId, cancelled: true });
      return;
    }
    this.queue.push(entry);
    this.processNext();
  }

  cancelAll() {
    this.aborted = true;
    for (const entry of this.queue) {
      entry.respond({ id: entry.requestId, cancelled: true });
    }
    this.queue = [];
  }

  reset() {
    this.queue = [];
    this.processing = false;
    this.aborted = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0 || !this.ui) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.aborted) {
      // Wait for any open overlay to close
      while (this.isOverlayOpen()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const entry = this.queue.shift()!;
      const { request, respond, agentName, requestId } = entry;
      const method = request.method;
      const pendingHint = this.queue.length > 0 ? ` (${this.queue.length} more pending)` : "";
      const decoratedTitle = `[${agentName}] ${request.title || request.message || ""}${pendingHint}`;

      try {
        if (method === "select") {
          const answer = await this.ui.select(decoratedTitle, request.options || []);
          if (answer === undefined) {
            respond({ id: requestId, cancelled: true });
          } else {
            respond({ id: requestId, value: answer });
          }
        } else if (method === "confirm") {
          const answer = await this.ui.confirm(decoratedTitle, request.message || "");
          respond({ id: requestId, confirmed: answer });
        } else if (method === "input") {
          const answer = await this.ui.input(decoratedTitle, request.placeholder || "");
          if (answer === undefined) {
            respond({ id: requestId, cancelled: true });
          } else {
            respond({ id: requestId, value: answer });
          }
        } else {
          respond({ id: requestId, cancelled: true });
        }
      } catch {
        respond({ id: requestId, cancelled: true });
      }
    }

    this.processing = false;
  }
}

// ---- TuiFlowIOAdapter -----------------------------------------------------

export class TuiFlowIOAdapter implements FlowIOAdapter {
  private queue = new AskUserQueue();

  constructor(
    private ui: any,
    private isOverlayOpen: () => boolean,
  ) {
    this.queue.setUI(ui, isOverlayOpen);
  }

  onFlowStart(): void {
    this.queue.reset();
    this.queue.setUI(this.ui, this.isOverlayOpen);
  }

  onFlowEnd(): void {
    this.queue.cancelAll();
  }

  notify(message: string): void {
    this.ui?.notify?.(message, "info");
  }

  handleExtensionUIRequest(
    agentName: string,
    request: { id: string; method: string; [key: string]: any },
    respond: (response: any) => void,
  ): void {
    this.queue.enqueue({
      requestId: request.id,
      agentName,
      request,
      respond,
    });
  }

  async askUser(
    question: string,
    type: "select" | "confirm" | "input" | "multiselect",
    options?: string[],
    extra?: AskUserExtra,
  ): Promise<AskUserResult> {
    const { ui } = this;
    const signal = extra?.signal;

    // Wait for any open detail overlay to close naturally before showing prompt
    while (this.isOverlayOpen()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // ── Multi-select: checkbox overlay ──
    if ((type === "multiselect" || extra?.multiSelect) && options) {
      if (ui.custom) {
        const selected: string[] = await ui.custom((tui: any, t: any, _kb: any, done: (val: string[]) => void) => {
          const checkboxItems: SelectItem[] = options.map((opt) => ({
            value: opt,
            label: opt,
          }));
          const checkbox = new CheckboxSelectList(checkboxItems, Math.min(checkboxItems.length, 12), {
            selectedPrefix: (text: string) => t.fg("accent", text),
            selectedText: (text: string) => t.fg("accent", text),
            description: (text: string) => t.fg("muted", text),
            scrollInfo: (text: string) => t.fg("dim", text),
            noMatch: (text: string) => t.fg("warning", text),
          });
          checkbox.onConfirm = (items: SelectItem[]) => done(items.map((s) => s.value));
          checkbox.onCancel = () => done([]);

          const onAbort = () => done([]);
          signal?.addEventListener("abort", onAbort, { once: true });

          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
          container.addChild(new Text(t.fg("accent", ` ${question}`), 0, 0));
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
        });
        if (!selected || selected.length === 0) throw new FlowCancelledError();
        return { answer: selected as any };
      }
      // Fallback: per-option confirm if ui.custom not available
      const selected: string[] = [];
      for (const opt of options) {
        const yes = await ui.confirm(
          `${question}\n  Include "${opt}"?`,
          "",
          { signal },
        );
        if (yes) selected.push(opt);
      }
      return { answer: selected as any };
    }

    // ── Select ──
    if (type === "select" && options) {
      const allOptions = [...options];
      if (extra?.allowCustom) allOptions.push("Other (describe)");

      const AUTO_DECIDE_OPTION = "Auto-decide (let AI choose)";
      if (extra?.hasAutoAgent && !isAutonomousMode()) {
        allOptions.push(AUTO_DECIDE_OPTION);
      }

      const branches = extra?.branches;
      const displayOptions = branches
        ? allOptions.map(opt => {
            const target = branches[opt];
            return target ? `${opt} → ${target}` : opt;
          })
        : allOptions;

      const answer = await ui.select(question, displayOptions, { signal });
      if (answer === undefined) throw new FlowCancelledError();

      let finalAnswer = answer;
      if (branches) {
        const originalOpt = allOptions.find(opt => {
          const target = branches[opt];
          return target ? `${opt} → ${target}` === answer : opt === answer;
        });
        if (originalOpt) finalAnswer = originalOpt;
      }

      if (finalAnswer === AUTO_DECIDE_OPTION) {
        setAutonomousMode(true);
        return { answer: "__auto_decide__" };
      }

      if (extra?.allowCustom && finalAnswer === "Other (describe)") {
        const custom = await ui.input("Describe:", "", { signal });
        if (custom === undefined) throw new FlowCancelledError();
        return { answer: "__custom_decide__", notes: custom };
      }

      let notes: string | undefined;
      const notesInput = await ui.input("Optional notes (Enter to skip):", "", { signal });
      if (notesInput === undefined) throw new FlowCancelledError();
      if (notesInput && notesInput.trim()) notes = notesInput.trim();

      return notes !== undefined ? { answer: finalAnswer, notes } : { answer: finalAnswer };
    }

    // ── Confirm ──
    if (type === "confirm") {
      const answer = await ui.confirm(question, "", { signal });
      return { answer: answer ? "yes" : "no" };
    }

    // ── Input (freetext) ──
    const answer = await ui.input(question, "", { signal });
    if (answer === undefined) throw new FlowCancelledError();
    return { answer: answer || "" };
  }
}

// ---- Headless adapter (auto-pick first option) ----------------------------

export class HeadlessFlowIOAdapter implements FlowIOAdapter {
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
    // No UI — cancel all extension UI requests
    respond({ id: request.id, cancelled: true });
  }
}
