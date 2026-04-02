import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FlowResult } from "../flow-engine/types.js";
import type { DetailEntry } from "../flow-dashboard/agent-dashboard.js";
import type { AgentCard } from "../flow-dashboard/agent-card.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { getModelRole as getModelRoleFromProvider } from "../role-manager.js";

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
export function computeStats(fr: FlowResult): { agentCount: number; duration: string; fileCount: number; perAgent: { name: string; status: string; fileCount: number }[] } {
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

// -- Helpers: get modelRegistry via event (no ctx dependency) -----------------
function getModelRegistry(pi: ExtensionAPI): any {
  const spawnCtx: any = {};
  pi.events.emit("flow:get-spawn-context", spawnCtx);
  return spawnCtx.modelRegistry ?? null;
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

    const stats = computeStats(fr);
    const nextStep = await resolveNextStep(fr.flowName, pkgRoot);

    // Notify TUI that summarization is starting (TUI renders spinner if present)
    pi.events.emit("flow:summary-started", { flowName: fr.flowName });

    // -- Phase 1: Call @compact LLM (or skip) ---------------------------------
    let insightLines: string[] = [];

    try {
      const modelId = getModelRoleFromProvider("compact");
      const modelRegistry = getModelRegistry(pi);
      if (modelId && modelRegistry) {
        const [provider, ...modelParts] = modelId.split("/");
        const model = modelRegistry.find(provider, modelParts.join("/"));
        if (model) {
          const auth = await modelRegistry.getApiKeyAndHeaders(model);
          if (auth.ok) {
            const { completeSimple } = await import("@mariozechner/pi-ai");
            const response = await completeSimple(model, {
              systemPrompt: SYSTEM_PROMPT,
              messages: [{ role: "user" as const, content: [{ type: "text" as const, text: buildUserMessage(fr) }], timestamp: Date.now() }],
            }, { apiKey: auth.apiKey, headers: auth.headers });

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

    // -- Phase 2: Persist summary to disk -------------------------------------
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
          const icon = agent.status === "complete" ? "✓"
            : agent.status === "skipped" ? "✓"
            : (agent.status === "blocked" || agent.status === "error") ? "⚠" : "✗";
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
      // Non-critical: don't break the summary if disk write fails
    }

    // -- Phase 3: Set summary state and emit ready event ----------------------
    const hasIssue = stats.perAgent.some(a => a.status === "error" || a.status === "blocked");
    const agentNames = Object.keys(fr.results);

    setSummaryState({
      mode: "summary",
      selectedIndex: 0,
      agentNames,
      flowResult: fr,
      summaryBoxHeight: 0,
    });

    // Emit summary-ready with all computed data — TUI and dashboard listen
    pi.events.emit("flow:summary-ready", {
      flowName: fr.flowName,
      flowResult: fr,
      stats,
      insightLines,
      hasIssue,
      nextStep,
      agentNames,
    });
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
