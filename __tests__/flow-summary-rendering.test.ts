import { describe, it, expect } from "vitest";
import { renderSummaryContent } from "../extensions/flow-summary/summary-render.js";
import { AgentCard } from "../extensions/flow-dashboard/agent-card.js";
import type { FlowResult, AgentResult } from "../extensions/flow-engine/types.js";

// Passthrough theme: strip styling so assertions match raw text.
const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};

function makeResult(name: string, summary: string): AgentResult {
  return {
    status: "complete",
    summary,
    artifacts: "",
    files: "",
    tokens: { input: 100, output: 50 },
    duration: 1200,
  } as unknown as AgentResult;
}

function makeCard(name: string): AgentCard {
  const card = new AgentCard(name, "complete", {
    renderMetric: () => `metric:${name}`,
  } as any);
  return card;
}

function makeFlowResult(names: string[]): FlowResult {
  const results: Record<string, AgentResult> = {};
  for (const n of names) results[n] = makeResult(n, `summary for ${n}`);
  return {
    flowName: "test-flow",
    status: "complete",
    results,
    totalDuration: 5000,
  } as unknown as FlowResult;
}

const stats = {
  agentCount: 2,
  duration: "5s",
  fileCount: 0,
  perAgent: [
    { name: "alpha", status: "complete", fileCount: 0 },
    { name: "beta", status: "complete", fileCount: 0 },
  ],
};

describe("post-flow summary rendering", () => {
  it("renders preserved agent cards above the per-agent summary lines", () => {
    const fr = makeFlowResult(["alpha", "beta"]);
    const cards = new Map<string, AgentCard>([
      ["alpha", makeCard("alpha")],
      ["beta", makeCard("beta")],
    ]);

    const lines = renderSummaryContent({
      flowResult: fr,
      stats,
      hasIssue: false,
      nextStep: null,
      cards,
      theme,
      width: 100,
    });

    const text = lines.join("\n");
    // Card body content (the metric) must be present — proves the card rendered.
    const cardIdx = text.indexOf("metric:alpha");
    // The per-agent summary line must be present.
    const summaryIdx = text.indexOf("summary for alpha");

    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    // Cards appear ABOVE the summary lines.
    expect(cardIdx).toBeLessThan(summaryIdx);
  });

  it("falls back to the summary line when an agent has no preserved card", () => {
    const fr = makeFlowResult(["alpha", "beta"]);
    // Only alpha has a card; beta is missing from the snapshot.
    const cards = new Map<string, AgentCard>([["alpha", makeCard("alpha")]]);

    expect(() =>
      renderSummaryContent({
        flowResult: fr,
        stats,
        hasIssue: false,
        nextStep: null,
        cards,
        theme,
        width: 100,
      }),
    ).not.toThrow();

    const text = renderSummaryContent({
      flowResult: fr,
      stats,
      hasIssue: false,
      nextStep: null,
      cards,
      theme,
      width: 100,
    }).join("\n");

    // beta still represented by its summary line despite no card.
    expect(text).toContain("summary for beta");
    expect(text).toContain("metric:alpha");
  });

  it("renders every preserved card, including subagents absent from fr.results", () => {
    // fr.results only knows the top-level step; the snapshot also holds a
    // subagent card whose name is NOT a result key (fork/loop/subagent).
    const fr = makeFlowResult(["alpha"]);
    const cards = new Map<string, AgentCard>([
      ["alpha", makeCard("alpha")],
      ["alpha:sub-1", makeCard("alpha:sub-1")],
    ]);

    const text = renderSummaryContent({
      flowResult: fr,
      stats: { ...stats, agentCount: 1, perAgent: [stats.perAgent[0]] },
      hasIssue: false,
      nextStep: null,
      cards,
      theme,
      width: 100,
    }).join("\n");

    // The subagent card renders even though it is not in fr.results.
    expect(text).toContain("metric:alpha:sub-1");
    expect(text).toContain("metric:alpha");
  });
});
