import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FlowResult } from "../flow-engine/types.js";
import type { DetailEntry } from "../flow-dashboard/agent-dashboard.js";
import type { AgentCard } from "../flow-dashboard/agent-card.js";
import { Text } from "@mariozechner/pi-tui";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { getModelRole as getModelRoleFromProvider } from "../provider-register.js";

export type SummaryMode = "summary" | "navigate";

// -- Module-level state (shared via single entry point) ----------------------

let summaryState: SummaryState | null = null;

export function getSummaryState(): SummaryState | null {
  return summaryState;
}

export function setSummaryState(state: SummaryState | null): void {
  summaryState = state;
}

interface SummaryState {
  mode: SummaryMode;
  selectedIndex: number;
  agentNames: string[];
  flowResult: FlowResult;
  summaryBoxHeight: number;
}

// -- Braille spinner frames ---------------------------------------------------
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 120;

// -- System prompt for @compact LLM -------------------------------------------
const SYSTEM_PROMPT = `You are a concise flow execution summarizer. Given per-agent summaries and artifacts from a completed flow, produce a brief digest.

Rules:
- Output one line per agent/domain, each starting with "•"
- Each line: "• <domain>: <key insight or outcome>" (max 80 chars)
- Focus on what was produced, decided, or discovered — not process details
- No preamble, no closing. Just the bullet lines.`;

// -- Duration formatting ------------------------------------------------------
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

// -- Stats computation from FlowResult ----------------------------------------
function computeStats(fr: FlowResult): { agentCount: number; duration: string; fileCount: number; perAgent: { name: string; status: string; fileCount: number }[] } {
  const entries = Object.entries(fr.results);
  let totalFiles = 0;
  const perAgent: { name: string; status: string; fileCount: number }[] = [];

  for (const [name, r] of entries) {
    const files = r.files ? r.files.split(", ").filter(Boolean).length : 0;
    totalFiles += files;
    perAgent.push({ name, status: r.status, fileCount: files });
  }

  return {
    agentCount: entries.length,
    duration: formatDuration(fr.totalDuration),
    fileCount: totalFiles,
    perAgent,
  };
}

// -- Build user message for LLM from FlowResult ------------------------------
function buildUserMessage(fr: FlowResult): string {
  const lines: string[] = [`Flow: ${fr.flowName}`, ""];
  for (const [name, r] of Object.entries(fr.results)) {
    lines.push(`## ${name} (${r.status})`);
    if (r.summary) lines.push(`Summary: ${r.summary}`);
    if (r.artifacts) lines.push(`Artifacts: ${r.artifacts}`);
    if (r.files) lines.push(`Files: ${r.files}`);
    lines.push("");
  }
  return lines.join("\n");
}

// -- Next-step resolution via workflow registry -------------------------------
async function resolveNextStep(flowName: string, pkgRoot: string): Promise<string | null> {
  try {
    const dashboardPath = join(pkgRoot, "extensions", "flow-dashboard", "index.js");
    const { resolveWorkflow } = await import(dashboardPath);
    const resolved = resolveWorkflow(flowName);
    if (!resolved) return null;
    const { workflow, stageIndex } = resolved;
    if (stageIndex + 1 >= workflow.stages.length) return null;
    const nextStage = workflow.stages[stageIndex + 1];
    return nextStage.flows[0] || null;
  } catch {
    return null;
  }
}

// -- Extension entry point ----------------------------------------------------
export function activate(pi: ExtensionAPI) {
  let ui: any = null;
  let modelRegistry: any = null;

  // Capture ctx references from session_start
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    modelRegistry = ctx.modelRegistry;
  });

  // Resolve package root from import.meta.url
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = join(dirname(__filename), "..", "..");

  // -- flow:complete handler --------------------------------------------------
  pi.events.on("flow:complete", async (data: unknown) => {
    const fr = data as FlowResult;
    if (!fr?.flowName || !fr?.results) return;
    if (!ui) return;

    const stats = computeStats(fr);
    const nextStep = await resolveNextStep(fr.flowName, pkgRoot);

    // -- Phase 1: Show spinner widget -----------------------------------------
    let spinnerFrame = 0;
    let spinnerTimer: ReturnType<typeof setInterval> | null = null;

    const setSpinnerWidget = () => {
      ui.setWidget("flow-summary", (_tui: any, theme: any) => {
        const text = new Text("", 0, 1);
        return {
          render(width: number): string[] {
            const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
            const line = theme.fg("accent", `${frame} Summarizing...`);
            text.setText(line);
            return text.render(width);
          },
          invalidate() {
            if (spinnerTimer) {
              clearInterval(spinnerTimer);
              spinnerTimer = null;
            }
          },
        };
      }, { placement: "aboveEditor" });
    };

    setSpinnerWidget();
    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      setSpinnerWidget();
    }, SPINNER_INTERVAL);

    // -- Phase 2: Call @compact LLM (or skip) ---------------------------------
    let insightLines: string[] = [];

    try {
      const modelId = getModelRoleFromProvider("compact");
      if (modelId && modelRegistry) {
        const [provider, ...modelParts] = modelId.split("/");
        const model = modelRegistry.find(provider, modelParts.join("/"));
        if (model) {
          const apiKey = await modelRegistry.getApiKey(model);
          if (apiKey) {
            const { completeSimple } = await import("@mariozechner/pi-ai");
            const response = await completeSimple(model, {
              systemPrompt: SYSTEM_PROMPT,
              messages: [{ role: "user" as const, content: [{ type: "text" as const, text: buildUserMessage(fr) }], timestamp: Date.now() }],
            }, { apiKey });

            // Extract text from response
            const text = response.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
            if (text) {
              insightLines = text.split("\n").filter(Boolean);
            }
          }
        }
      }
    } catch {
      // Graceful fallback: no LLM insight lines
    }

    // -- Phase 2b: Persist summary to disk ------------------------------------
    try {
      const resultsDir = join(process.cwd(), ".pi", "flows", "results");
      mkdirSync(resultsDir, { recursive: true });

      const summaryPath = join(resultsDir, `${fr.flowName}.md`);
      const jsonPath = join(resultsDir, `${fr.flowName}.json`);

      // Read existing file before overwriting (acknowledge any manual annotations)
      if (existsSync(summaryPath)) {
        try { readFileSync(summaryPath, "utf-8"); } catch { /* ignore */ }
      }

      // Build markdown summary
      const summaryMdLines: string[] = [];
      summaryMdLines.push(`## Flow: ${fr.flowName}`);
      summaryMdLines.push(`Duration: ${stats.duration} | Agents: ${stats.agentCount} | Files: ${stats.fileCount}`);
      summaryMdLines.push("");
      summaryMdLines.push("### Results");
      if (insightLines.length > 0) {
        for (const line of insightLines) {
          summaryMdLines.push(line);
        }
      } else {
        for (const agent of stats.perAgent) {
          const icon = agent.status === "complete" ? "✓" : "✗";
          const detail = agent.fileCount > 0 ? ` (${agent.fileCount} files)` : "";
          summaryMdLines.push(`${icon} ${agent.name}${detail}`);
        }
      }
      summaryMdLines.push("");
      summaryMdLines.push("### Files Modified");
      for (const [name, r] of Object.entries(fr.results)) {
        if (r.files) {
          summaryMdLines.push(`- **${name}**: ${r.files}`);
        }
      }

      writeFileSync(summaryPath, summaryMdLines.join("\n"), "utf-8");
      writeFileSync(jsonPath, JSON.stringify(fr, null, 2), "utf-8");
    } catch {
      // Non-critical: don't break the summary widget if disk write fails
    }

    // -- Phase 3: Clear spinner, render summary box ---------------------------
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }

    const allComplete = stats.perAgent.every(a => a.status === "complete");
    const statusIcon = allComplete ? "✓" : "⚠";
    const agentNames = Object.keys(fr.results);

    // Set summary state (accessible via direct import from flow-engine)
    setSummaryState({
      mode: "summary",
      selectedIndex: 0,
      agentNames,
      flowResult: fr,
      summaryBoxHeight: 0,
    });

    ui.setWidget("flow-summary", (_tui: any, theme: any) => {
      let tuiRef = _tui;
      const text = new Text("", 0, 1);
      return {
        render(width: number): string[] {
          const state = getSummaryState();
          if (!state) return [];
          const inner = width - 4;

          // ── Navigate mode: agent list with card metrics ──
          if (state.mode === "navigate") {
            const lines: string[] = [];
            const bw = width - 2; // inner width between │ borders
            const bi = bw - 2;    // content width inside │ + space padding

            // Top border
            lines.push(theme.fg("dim", "┌" + "─".repeat(bw) + "┐"));

            // Header
            const navHeader = `${fr.flowName} · Select agent`;
            lines.push(theme.fg("dim", "│ ") + theme.fg("accent", navHeader.padEnd(bi)) + theme.fg("dim", " │"));
            lines.push(theme.fg("dim", "├" + "─".repeat(bw) + "┤"));

            for (let i = 0; i < agentNames.length; i++) {
              const name = agentNames[i];
              const result = fr.results[name];
              const sel = i === state.selectedIndex ? ">" : " ";
              const statusStr = result?.status || "unknown";
              const sIcon = statusStr === "complete" ? theme.fg("success", "✓")
                : statusStr === "error" ? theme.fg("error", "✗") : theme.fg("dim", "○");

              // Try to get card metric from preserved cards
              let metricStr = "";
              const card = lastCardsRef?.get(name);
              if (card) {
                const metric = card.renderer.renderMetric(Math.max(10, bi - name.length - 8));
                if (metric) metricStr = theme.fg("dim", "  " + metric.trim());
              } else {
                // Fallback: show event count
                const eventCount = lastEventLogRef?.get(name)?.length ?? 0;
                if (eventCount > 0) metricStr = theme.fg("dim", ` · ${eventCount} events`);
              }

              const agentLine = `${sel} ${sIcon} ${name}${metricStr}`;
              lines.push(theme.fg("dim", "│ ") + agentLine.padEnd(bi) + theme.fg("dim", " │"));
            }

            // Footer hint
            lines.push(theme.fg("dim", "├" + "─".repeat(bw) + "┤"));
            lines.push(theme.fg("dim", "│ ") + theme.fg("dim", "↑↓ navigate · Enter inspect · Backspace back").padEnd(bi) + theme.fg("dim", " │"));
            lines.push(theme.fg("dim", "└" + "─".repeat(bw) + "┘"));

            // Pad to match summary box height
            while (lines.length < state.summaryBoxHeight) lines.push("");
            state.summaryBoxHeight = Math.max(state.summaryBoxHeight, lines.length);
            return lines;
          }

          // ── Summary box mode (default) ──
          const lines: string[] = [];

          // Top border
          lines.push(theme.fg("dim", "┌" + "─".repeat(width - 2) + "┐"));

          // Header line
          const header = `${statusIcon} ${fr.flowName} complete · ${stats.agentCount} agents · ${stats.duration}`;
          lines.push(theme.fg("dim", "│ ") + theme.fg("accent", header.padEnd(inner)) + theme.fg("dim", " │"));

          // Separator
          lines.push(theme.fg("dim", "├" + "─".repeat(width - 2) + "┤"));

          // LLM insight lines (or per-agent status if no insights)
          if (insightLines.length > 0) {
            for (const line of insightLines) {
              const trimmed = line.length > inner ? line.slice(0, inner - 1) + "…" : line;
              lines.push(theme.fg("dim", "│ ") + trimmed.padEnd(inner) + theme.fg("dim", " │"));
            }
          } else {
            // Structured-only fallback: per-agent status
            for (const agent of stats.perAgent) {
              const icon = agent.status === "complete" ? theme.fg("success", "✓") : theme.fg("error", "✗");
              const detail = agent.fileCount > 0 ? ` (${agent.fileCount} files)` : "";
              const line = `${icon} ${agent.name}${detail}`;
              lines.push(theme.fg("dim", "│ ") + line.padEnd(inner) + theme.fg("dim", " │"));
            }
          }

          // Next step (workflow pipeline only)
          if (nextStep) {
            lines.push(theme.fg("dim", "├" + "─".repeat(width - 2) + "┤"));
            const nextLine = `Next: /${nextStep}`;
            lines.push(theme.fg("dim", "│ ") + theme.fg("warning", nextLine.padEnd(inner)) + theme.fg("dim", " │"));
          }

          // Ctrl+O hint
          lines.push(theme.fg("dim", "├" + "─".repeat(width - 2) + "┤"));
          lines.push(theme.fg("dim", "│ ") + theme.fg("dim", "Ctrl+O inspect agents · Ctrl+X dismiss").padEnd(inner) + theme.fg("dim", " │"));

          // Bottom border
          lines.push(theme.fg("dim", "└" + "─".repeat(width - 2) + "┘"));

          // Track the summary box height for matching in other modes
          state.summaryBoxHeight = lines.length;

          text.setText(lines.join("\n"));
          return text.render(width);
        },
        invalidate() { /* static content, no cleanup needed */ },
      };
    }, { placement: "aboveEditor" });
  });

  // Receive summary context from flow-engine (tool history + preserved cards)
  pi.events.on("flow:set-summary-context", (data: any) => {
    lastEventLogRef = data?.toolHistory || null;
    lastCardsRef = data?.cards || null;
  });

  // Legacy event name support
  pi.events.on("flow:set-summary-tool-history", (data: any) => {
    lastEventLogRef = data?.toolHistory || null;
  });
}

// Module-scoped refs for tool history and preserved cards
let lastEventLogRef: Map<string, DetailEntry[]> | null = null;
let lastCardsRef: Map<string, AgentCard> | null = null;

// getSummaryState is exported at the top of this file.
