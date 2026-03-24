// ---------------------------------------------------------------------------
// Flow Preview Overlay
//
// TUI Component that renders full flow structure as an overlay:
// agents, wirings, DAG with all step types, loops, forks, conditionals.
// ---------------------------------------------------------------------------

import type {
  FlowConfig,
  FlowStep,
  AgentStep,
  ForkStep,
  ConditionalStep,
  AgentDecisionStep,
  AgentLoopDecisionStep,
  FlowRefStep,
} from "../flow-engine/types.js";
import { visibleWidth } from "@mariozechner/pi-tui";

/** Pad a line (which may contain ANSI codes) with trailing spaces to exactly `targetWidth` visible characters. */
function padLine(line: string, targetWidth: number): string {
  const vw = visibleWidth(line);
  if (vw >= targetWidth) return line;
  return line + " ".repeat(targetWidth - vw);
}

// Key constants
const KEY_ESC = "\x1b";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_BACKSPACE_1 = "\x7f";
const KEY_BACKSPACE_2 = "\b";

// Step type symbols
const SYMBOLS: Record<string, string> = {
  agent: "○",
  fork: "◇",
  conditional: "◆",
  "agent-decision": "◈",
  "agent-loop-decision": "↻",
  "flow-ref": "▷",
};

export interface FlowPreviewOverlayOptions {
  flow: FlowConfig;
  theme: any;
  tui: any;
  done: (result: null) => void;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/**
 * Build the full rendered lines for the flow preview.
 */
function buildFlowPreviewLines(flow: FlowConfig, width: number, theme: any): string[] {
  const fg = (c: string, t: string) => theme?.fg?.(c, t) ?? t;
  const inner = width - 4;
  const lines: string[] = [];

  // ── Header ──
  lines.push(`  ${fg("accent", flow.name)}`);
  if (flow.description) {
    lines.push(`  ${fg("muted", truncate(flow.description, inner))}`);
  }
  const metaParts: string[] = [`${flow.steps.length} steps`];
  if (flow.max_concurrent) metaParts.push(`max concurrent: ${flow.max_concurrent}`);
  const loopCount = flow.steps.filter(s => s.stepType === "agent-loop-decision").length;
  if (loopCount > 0) metaParts.push(`${loopCount} loop${loopCount > 1 ? "s" : ""}`);
  lines.push(`  ${fg("dim", metaParts.join(" │ "))}`);
  lines.push(fg("dim", "  " + "─".repeat(Math.max(0, inner))));
  lines.push("");

  // ── Steps ──
  lines.push(`  ${fg("dim", "Steps:")}`);
  lines.push("");

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const num = `${i + 1}.`;
    const sym = SYMBOLS[step.stepType] || "?";

    switch (step.stepType) {
      case "agent": {
        const s = step as AgentStep;
        lines.push(`  ${fg("dim", num)} ${fg("accent", sym)} ${fg("accent", s.id)}`);
        if (s.task) lines.push(`     ${fg("muted", truncate("task: " + s.task, inner - 5))}`);
        if (s.model) lines.push(`     ${fg("dim", "model: " + s.model)}`);
        if (s.blockedBy?.length) lines.push(`     ${fg("dim", "blockedBy: " + s.blockedBy.join(", "))}`);
        if (s.inputs) {
          for (const [key, val] of Object.entries(s.inputs)) {
            lines.push(`     ${fg("dim", `input: ${key} ← ${truncate(val, inner - 15)}`)}`);
          }
        }
        if (s.on_complete) lines.push(`     ${fg("dim", `→ on_complete: ${s.on_complete}`)}`);
        if (s.on_error) lines.push(`     ${fg("dim", `→ on_error: ${s.on_error}`)}`);
        break;
      }

      case "fork": {
        const s = step as ForkStep;
        lines.push(`  ${fg("dim", num)} ${fg("warning", sym)} ${fg("accent", s.id)} ${fg("dim", "(fork)")}`);
        lines.push(`     ${fg("muted", truncate("question: " + s.question, inner - 5))}`);
        for (const [opt, target] of Object.entries(s.branches)) {
          lines.push(`     ${fg("dim", `"${opt}" → ${target}`)}`);
        }
        break;
      }

      case "conditional": {
        const s = step as ConditionalStep;
        lines.push(`  ${fg("dim", num)} ${fg("warning", sym)} ${fg("accent", s.id)} ${fg("dim", "(conditional)")}`);
        lines.push(`     ${fg("dim", `check: ${s.check}`)}`);
        lines.push(`     ${fg("dim", `present → ${s.present}`)}`);
        lines.push(`     ${fg("dim", `absent → ${s.absent}`)}`);
        break;
      }

      case "agent-decision": {
        const s = step as AgentDecisionStep;
        lines.push(`  ${fg("dim", num)} ${fg("warning", sym)} ${fg("accent", s.id)} ${fg("dim", "(agent-decision)")}`);
        lines.push(`     ${fg("dim", `agent: ${s.agent}`)}`);
        lines.push(`     ${fg("muted", truncate("task: " + s.task, inner - 5))}`);
        for (const [branch, target] of Object.entries(s.branches)) {
          lines.push(`     ${fg("dim", `"${branch}" → ${target}`)}`);
        }
        break;
      }

      case "agent-loop-decision": {
        const s = step as AgentLoopDecisionStep;
        lines.push(`  ${fg("dim", num)} ${fg("accent", sym)} ${fg("accent", s.id)} ${fg("dim", "(loop)")}`);
        lines.push(`     ${fg("dim", `agent: ${s.agent}`)}`);
        lines.push(`     ${fg("muted", truncate("task: " + s.task, inner - 5))}`);
        lines.push(`     ${fg("accent", `loop → ${s.loop_target}`)}  ${fg("dim", `(max ${s.max_iterations} iterations)`)}`);
        lines.push(`     ${fg("dim", `exit → ${s.exit_target}`)}`);
        break;
      }

      case "flow-ref": {
        const s = step as FlowRefStep;
        lines.push(`  ${fg("dim", num)} ${fg("dim", sym)} ${fg("accent", s.id)} ${fg("dim", "(flow-ref)")}`);
        lines.push(`     ${fg("dim", `path: ${s.path}`)}`);
        if (s.on_complete) lines.push(`     ${fg("dim", `→ on_complete: ${s.on_complete}`)}`);
        if (s.on_error) lines.push(`     ${fg("dim", `→ on_error: ${s.on_error}`)}`);
        break;
      }
    }

    lines.push(""); // blank line between steps
  }

  // ── Wiring DAG ──
  const agentSteps = flow.steps.filter((s): s is AgentStep => s.stepType === "agent");
  const depsExist = agentSteps.some(s => s.blockedBy && s.blockedBy.length > 0);

  if (depsExist) {
    lines.push(`  ${fg("dim", "Wiring:")}`);
    lines.push("");

    // Build parent → children map
    const childMap = new Map<string, AgentStep[]>();
    const roots = agentSteps.filter(s => !s.blockedBy || s.blockedBy.length === 0);

    for (const step of agentSteps) {
      if (step.blockedBy) {
        for (const dep of step.blockedBy) {
          if (!childMap.has(dep)) childMap.set(dep, []);
          childMap.get(dep)!.push(step);
        }
      }
    }

    const rendered = new Set<string>();

    function renderNode(step: AgentStep, prefix: string, isLast: boolean, isRoot: boolean): void {
      if (rendered.has(step.id)) return;
      rendered.add(step.id);

      const connector = isRoot ? "  " : isLast ? "└── " : "├── ";
      const connectorStyled = isRoot ? "  " : fg("dim", connector);
      let line = `${prefix}${connectorStyled}${fg("accent", "○")} ${fg("accent", step.id)}`;
      lines.push(line);

      // Show input mappings inline
      if (step.inputs) {
        const childPrefix = isRoot ? "    " : prefix + (isLast ? "    " : fg("dim", "│") + "   ");
        for (const [key, val] of Object.entries(step.inputs)) {
          lines.push(`${childPrefix}  ${fg("dim", `input: ${key} ← ${truncate(val, inner - 20)}`)}`);
        }
      }

      const children = childMap.get(step.id) || [];
      const childPfx = isRoot ? "  " : prefix + (isLast ? "    " : fg("dim", "│") + "   ");
      for (let i = 0; i < children.length; i++) {
        renderNode(children[i], childPfx, i === children.length - 1, false);
      }
    }

    for (let i = 0; i < roots.length; i++) {
      renderNode(roots[i], "", true, true);
    }

    // Render any orphaned steps
    for (const step of agentSteps) {
      if (!rendered.has(step.id)) {
        lines.push(`  ${fg("accent", "○")} ${fg("accent", step.id)} ${fg("dim", `(blockedBy: ${step.blockedBy?.join(", ")})`)}`);
      }
    }

    lines.push("");
  }

  // ── Legend ──
  lines.push(fg("dim", `  Legend: ○ agent  ◇ fork  ◆ conditional  ◈ decision  ↻ loop  ▷ flow-ref`));
  lines.push("");
  lines.push(fg("dim", "  ↑↓ scroll · Backspace close"));

  return lines;
}

/**
 * Create a flow preview overlay component.
 */
export function createFlowPreviewOverlay(opts: FlowPreviewOverlayOptions) {
  const { flow, theme, tui, done } = opts;
  const fg = (c: string, t: string) => theme?.fg?.(c, t) ?? t;

  let scrollOffset = 0;
  let allLines: string[] | null = null;

  return {
    render(width: number): string[] {
      const w = width - 2; // inner width between │ borders
      const innerWidth = Math.max(20, w - 2); // with 1 char padding each side

      // Build lines on first render
      allLines = buildFlowPreviewLines(flow, innerWidth, theme);

      const termRows = tui?.terminal?.rows ?? 40;
      // Account for top + bottom border
      const viewportHeight = Math.max(10, Math.floor(termRows * 0.85) - 6);

      // Clamp scroll
      const maxScroll = Math.max(0, allLines.length - viewportHeight);
      if (scrollOffset > maxScroll) scrollOffset = maxScroll;

      const visible = allLines.slice(scrollOffset, scrollOffset + viewportHeight);

      // Pad to viewport height
      while (visible.length < viewportHeight) visible.push("");

      // Wrap in bordered box
      const bord = (s: string) => fg("dim", s);
      const lines: string[] = [];

      lines.push(bord("┌" + "─".repeat(w) + "┐"));
      for (const line of visible) {
        lines.push(bord("│") + " " + padLine(line, innerWidth) + " " + bord("│"));
      }
      lines.push(bord("└" + "─".repeat(w) + "┘"));

      return lines;
    },

    handleInput(data: string): void {
      if (data === KEY_ESC || data === KEY_BACKSPACE_1 || data === KEY_BACKSPACE_2) {
        done(null);
        return;
      }

      if (data === KEY_UP) {
        if (scrollOffset > 0) {
          scrollOffset--;
          tui?.requestRender();
        }
        return;
      }

      if (data === KEY_DOWN) {
        if (allLines) {
          const termRows = tui?.terminal?.rows ?? 40;
          const viewportHeight = Math.max(10, Math.floor(termRows * 0.85) - 6);
          const maxScroll = Math.max(0, allLines.length - viewportHeight);
          if (scrollOffset < maxScroll) {
            scrollOffset++;
            tui?.requestRender();
          }
        }
        return;
      }
    },

    invalidate(): void {
      allLines = null;
    },
  };
}
