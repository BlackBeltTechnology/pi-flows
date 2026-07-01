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
  AgentDecisionStep,
  CodeDecisionStep,
} from "../flow-engine/types.js";
import { renderBox } from "./box-renderer.js";

// Key constants
const KEY_ESC = "\x1b";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_BACKSPACE_1 = "\x7f";
const KEY_BACKSPACE_2 = "\b";

// Step type symbols
const SYMBOLS: Record<string, string> = {
  agent: "○",
  code: "▣",
  "code-decision": "◈",
  fork: "◇",
  "agent-decision": "◈",
};

/**
 * A *-decision branch is a backward (loop) edge when its target sits at or
 * before the deciding step in document order. Mirrors the engine's runtime
 * detection (isBackwardTarget) so the preview's loop arrows match execution.
 */
function backwardBranches(
  flow: FlowConfig,
  stepId: string,
  branches: Record<string, string>,
): Array<[string, string]> {
  const order = flow.steps.map((s) => s.id);
  const si = order.indexOf(stepId);
  return Object.entries(branches).filter(([, target]) => {
    const ti = order.indexOf(target);
    return ti >= 0 && si >= 0 && ti <= si;
  });
}

export interface FlowPreviewOverlayOptions {
  flow: FlowConfig;
  theme: any;
  tui: any;
  done: (result: null) => void;
}

function truncate(s: string, max: number): string {
  // Collapse newlines and extra whitespace (YAML multi-line strings)
  const clean = s.replace(/\s*\n\s*/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + "...";
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
  // A loop is any *-decision with a backward branch edge.
  const loopCount = flow.steps.filter((s) =>
    (s.stepType === "agent-decision" || s.stepType === "code-decision") &&
    backwardBranches(flow, s.id, (s as AgentDecisionStep | CodeDecisionStep).branches ?? {}).length > 0,
  ).length;
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
        // AgentStep has no `model` field in the current type definitions; preserve
        // any runtime-attached value via a permissive read.
        const stepModel = (s as any).model;
        if (stepModel) lines.push(`     ${fg("dim", "model: " + stepModel)}`);
        if (s.blockedBy?.length) lines.push(`     ${fg("dim", "blockedBy: " + s.blockedBy.join(", "))}`);
        if (s.inputs) {
          for (const [key, val] of Object.entries(s.inputs)) {
            lines.push(`     ${fg("dim", `input: ${key} ← ${truncate(val, inner - 15)}`)}`);
          }
        }
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

      case "agent-decision":
      case "code-decision": {
        const s = step as AgentDecisionStep | CodeDecisionStep;
        const back = new Set(backwardBranches(flow, s.id, s.branches ?? {}).map(([b]) => b));
        const looping = back.size > 0;
        const tag = step.stepType === "code-decision" ? "code-decision" : "agent-decision";
        const symStyle = looping ? "accent" : "warning";
        const symbol = looping ? "↻" : sym;
        lines.push(`  ${fg("dim", num)} ${fg(symStyle, symbol)} ${fg("accent", s.id)} ${fg("dim", `(${tag}${looping ? ", loop" : ""})`)}`);
        if (step.stepType === "agent-decision") {
          lines.push(`     ${fg("dim", `agent: ${(s as AgentDecisionStep).agent}`)}`);
          lines.push(`     ${fg("muted", truncate("task: " + (s as AgentDecisionStep).task, inner - 5))}`);
        }
        const maxIter = (s as { max_iterations?: number }).max_iterations;
        for (const [branch, target] of Object.entries(s.branches ?? {})) {
          if (back.has(branch)) {
            const cap = typeof maxIter === "number" ? `  ${fg("dim", `(max ${maxIter} iterations)`)}` : "";
            lines.push(`     ${fg("accent", `"${branch}" ↻ ${target}`)}${cap}`);
          } else {
            lines.push(`     ${fg("dim", `"${branch}" → ${target}`)}`);
          }
        }
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
  lines.push(fg("dim", `  Legend: ○ agent  ▣ code  ◈ decision  ◇ fork  ↻ loop`));
  lines.push("");
  lines.push(fg("dim", "  ↑ ↓ scroll · Backspace close"));

  return lines;
}

/**
 * Create a flow preview overlay component.
 */
export function createFlowPreviewOverlay(opts: FlowPreviewOverlayOptions) {
  const { flow, theme, tui, done } = opts;

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

      return renderBox({ width, theme, content: visible });
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
