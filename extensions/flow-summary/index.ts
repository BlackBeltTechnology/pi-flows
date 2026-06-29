import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlowResult } from "../flow-engine/types.js";
import type { DetailEntry } from "../flow-dashboard/agent-dashboard.js";
import type { AgentCard } from "../flow-dashboard/agent-card.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

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

// -- Duration formatting ------------------------------------------------------
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

// -- Stats computation from FlowResult ----------------------------------------
export function computeStats(fr: FlowResult): { agentCount: number; duration: string; fileCount: number; perAgent: { name: string; status: string; fileCount: number }[] } {
  const entries = Object.entries(fr.results);
  let totalFiles = 0;
  const perAgent: { name: string; status: string; fileCount: number }[] = [];

  for (const [name, r] of entries) {
    // File tracking was removed from the result contract (typed-io change);
    // fileCount is retained at 0 for render/back-compat.
    perAgent.push({ name, status: r.status, fileCount: 0 });
  }
  void totalFiles;

  return {
    agentCount: entries.length,
    duration: formatDuration(fr.totalDuration),
    fileCount: totalFiles,
    perAgent,
  };
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
  // Resolve package root from import.meta.url
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = join(dirname(__filename), "..", "..");

  // -- flow:complete handler --------------------------------------------------
  pi.events.on("flow:complete", async (data: unknown) => {
    const fr = data as FlowResult;
    if (!fr?.flowName || !fr?.results) return;

    // Signal the start of the summary lifecycle so dashboard observers can
    // render a "generating summary…" intermediate state. The matching
    // flow:summary-ready emission follows once the payload is computed.
    pi.events.emit("flow:summary-started", { flowName: fr.flowName });

    const stats = computeStats(fr);
    const nextStep = await resolveNextStep(fr.flowName, pkgRoot);

    // -- Phase 1: Persist summary to disk (using per-agent finish summaries) --
    try {
      const resultsDir = join(process.cwd(), ".pi", "flows", "results");
      mkdirSync(resultsDir, { recursive: true });

      const summaryPath = join(resultsDir, `${fr.flowName}.md`);
      const jsonPath = join(resultsDir, `${fr.flowName}.json`);

      // Build markdown summary from per-agent finish data
      const summaryMdLines: string[] = [];
      summaryMdLines.push(`## Flow: ${fr.flowName}`);
      summaryMdLines.push(`Duration: ${stats.duration} | Agents: ${stats.agentCount}`);
      summaryMdLines.push("");
      summaryMdLines.push("### Results");
      for (const [name, r] of Object.entries(fr.results)) {
        const icon = r.status === "complete" ? "✓"
          : r.status === "skipped" ? "✓"
          : (r.status === "blocked" || r.status === "error") ? "⚠" : "✗";
        const summary = r.summary ? `: ${r.summary}` : "";
        summaryMdLines.push(`${icon} ${name}${summary}`);
      }
      summaryMdLines.push("");

      writeFileSync(summaryPath, summaryMdLines.join("\n"), "utf-8");
      writeFileSync(jsonPath, JSON.stringify(fr, null, 2), "utf-8");
    } catch {
      // Non-critical: don't break the summary if disk write fails
    }

    // -- Phase 2: Set summary state and emit ready event ----------------------
    const hasIssue = stats.perAgent.some(a => a.status === "error" || a.status === "blocked");
    const agentNames = Object.keys(fr.results);

    setSummaryState({
      mode: "summary",
      selectedIndex: 0,
      agentNames,
      flowResult: fr,
      summaryBoxHeight: 0,
    });

    // Emit summary-ready with computed data — TUI and dashboard listen
    pi.events.emit("flow:summary-ready", {
      flowName: fr.flowName,
      flowResult: fr,
      stats,
      hasIssue,
      nextStep,
      agentNames,
    });
  });

  // Clear summary state when dismissed from either TUI or dashboard
  pi.events.on("flow:summary-dismissed", () => {
    setSummaryState(null);
  });

  // Receive summary context from flow-engine (tool history + preserved cards)
  pi.events.on("flow:set-summary-context", (data: any) => {
    lastEventLogRef = data?.toolHistory || null;
    lastCardsRef = data?.cards || null;
  });
}

// Module-scoped refs for tool history and preserved cards
let lastEventLogRef: Map<string, DetailEntry[]> | null = null;
let lastCardsRef: Map<string, AgentCard> | null = null;

export function getLastEventLog(): Map<string, DetailEntry[]> | null {
  return lastEventLogRef;
}

export function getLastCards(): Map<string, AgentCard> | null {
  return lastCardsRef;
}
