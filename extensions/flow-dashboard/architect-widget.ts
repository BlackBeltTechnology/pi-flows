// ---------------------------------------------------------------------------
// Flow Architect Design Widget
//
// Full-width TUI component rendered above the editor during the Flow
// Architect's design phase.  Tracks tool calls (agent_catalog, agent_write,
// flow_write) and renders a live-updating
// box showing:
//   - Spinner + flow name header
//   - Agent list (built-in vs custom, with creation progress)
//   - DAG visualization of flow steps
//   - Status bar with current activity
//   - Preview mode when flow_write succeeds
// ---------------------------------------------------------------------------

import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { renderBox } from "./box-renderer.js";
import { parseFlowYamlString } from "../flow-engine/flow-parser-yaml.js";
import type { FlowConfig, AgentStep } from "../flow-engine/types.js";

// ---- Spinner frames --------------------------------------------------------

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const SPINNER_INTERVAL = 120;

// ---- Agent entry state -----------------------------------------------------

interface AgentEntry {
  name: string;
  type: "built-in" | "local" | "custom";
  status: "pending" | "creating" | "done" | "error";
  statusText?: string; // e.g., "Writing frontmatter..."
}

// ---- Tool call input preview (same logic as agent-card.ts) -----------------

function extractInputPreview(toolName: string, input: any): string {
  if (!input) return "";
  switch (toolName) {
    case "Read": case "read":
    case "Write": case "write":
    case "Edit": case "edit":
      return ((input.file_path || input.path || "") as string).split("/").pop() || "";
    case "Grep": case "grep":
      return (input.pattern || "").slice(0, 20);
    case "Bash": case "bash":
      return (input.command || "").slice(0, 20);
    case "flow_write":
      return input.name || "";
    default:
      return JSON.stringify(input).slice(0, 20);
  }
}

// ---- DAG step entry --------------------------------------------------------

interface DagStep {
  id: string;
  agentName?: string;  // Agent name (may differ from step id); used for agent list matching
  blockedBy: string[];
  task: string;
  sourceType: "built-in" | "local" | "custom";
}

// ---- Widget mode -----------------------------------------------------------

type WidgetMode = "design" | "preview";
type PreviewSubMode = "preview" | "navigate";

// ---- Parsed flow entry (for multi-flow preview) ----------------------------

interface ParsedFlowEntry {
  name: string;
  description: string;
  maxConcurrent: number;
  steps: DagStep[];
}

// ---- Internal state --------------------------------------------------------

/** Pending prompt shown inline in the widget */
interface WidgetPrompt {
  id: string;
  type: "select" | "input";
  question: string;
  options?: string[];
  selectedIndex: number;  // For select type: which option is highlighted
  inputValue: string;     // For input type: current text
}

interface ArchitectState {
  mode: WidgetMode;
  previewSubMode: PreviewSubMode;
  selectedFlowIndex: number;
  flowName: string;
  flowDescription: string;
  flowPath: string;
  maxConcurrent: number;
  agents: AgentEntry[];
  dagSteps: DagStep[];
  parsedFlows: ParsedFlowEntry[];
  statusLeft: string;
  statusRight: string;
  spinFrame: number;
  flowWritten: boolean;
  previewApproval: string; // e.g., "Awaiting approval..."
  lastToolCall: { toolName: string; inputPreview: string } | null;
  architectModel: string;       // Resolved model ID (e.g., "anthropic/claude-opus-4-6")
  architectModelAlias: string;  // Raw model alias (e.g., "@planning")
  /** Inline prompt (Save/Replan/Cancel, input questions) */
  prompt: WidgetPrompt | null;
  /** Validation diagnostics from flow_write failure */
  validationErrors: Array<{ line: number; severity: string; message: string }>;
}

// ---- Flow content parser (uses canonical YAML parser) ---------------------

function parseFlowForWidget(content: string): { name: string; description: string; maxConcurrent: number; steps: DagStep[] } {
  try {
    const flow: FlowConfig = parseFlowYamlString(content, "<widget>");
    const steps: DagStep[] = flow.steps.map((step) => {
      if (step.stepType === "agent") {
        const agentStep = step as AgentStep;
        return {
          id: agentStep.id,
          agentName: agentStep.agent,  // Actual agent name (may differ from step id)
          blockedBy: agentStep.blockedBy || [],
          task: agentStep.task || "",
          sourceType: "built-in" as const,
        };
      }
      // Non-agent step types (fork, conditional, agent-decision, etc.)
      return {
        id: step.id,
        blockedBy: [],
        task: "",
        sourceType: "built-in" as const,
      };
    });
    return {
      name: flow.name,
      description: flow.description,
      maxConcurrent: flow.max_concurrent || 0,
      steps,
    };
  } catch {
    // Graceful degradation: extract name/description via regex, return empty steps
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const concMatch = content.match(/^max_concurrent:\s*(\d+)$/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      description: descMatch ? descMatch[1].trim() : "",
      maxConcurrent: concMatch ? parseInt(concMatch[1], 10) : 0,
      steps: [],
    };
  }
}

// ---- Extract agent name from agent_write path or content -------------------

function extractAgentName(input: any): string {
  if (!input) return "unknown";
  // Try path: last segment without extension
  if (input.path) {
    const seg = (input.path as string).split("/").pop() || "";
    return seg.replace(/\.md$/, "") || "unknown";
  }
  // Try content frontmatter name:
  if (input.content) {
    const m = (input.content as string).match(/^name:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  return "unknown";
}

// ---- DAG tree renderer -----------------------------------------------------

function renderDag(steps: DagStep[], theme: any): string[] {
  if (steps.length === 0) return [];

  const lines: string[] = [];

  // Build parent -> children map (a child is a step that has blockedBy entries)
  // Root nodes: steps with no blockedBy
  const roots = steps.filter((s) => s.blockedBy.length === 0);
  const childMap = new Map<string, DagStep[]>();

  for (const step of steps) {
    for (const dep of step.blockedBy) {
      if (!childMap.has(dep)) childMap.set(dep, []);
      childMap.get(dep)!.push(step);
    }
  }

  // Track which steps have been rendered to avoid duplicates
  const rendered = new Set<string>();

  function renderNode(step: DagStep, prefix: string, isLast: boolean, isRoot: boolean): void {
    if (rendered.has(step.id)) return;
    rendered.add(step.id);

    const icon = theme.fg("dim", "\u25CB");
    const connector = isRoot
      ? "  "
      : isLast
        ? "\u2514\u2500\u2500 "
        : "\u251C\u2500\u2500 ";
    const depLabel =
      step.blockedBy.length > 0
        ? theme.fg("dim", `  (blockedBy: ${step.blockedBy.join(", ")})`)
        : "";
    const connectorStyled = isRoot ? "  " : theme.fg("dim", connector);
    lines.push(`${prefix}${connectorStyled}${icon} ${theme.fg("accent", step.id)}${depLabel}`);

    const children = childMap.get(step.id) || [];
    const childPrefix = isRoot
      ? "  "
      : prefix + (isLast ? "    " : theme.fg("dim", "\u2502") + "   ");

    for (let i = 0; i < children.length; i++) {
      renderNode(children[i], childPrefix, i === children.length - 1, false);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    renderNode(roots[i], "", true, true);
  }

  // Render any orphaned steps (blockedBy references that aren't roots and weren't
  // already rendered as children — shouldn't happen normally, but handle gracefully)
  for (const step of steps) {
    if (!rendered.has(step.id)) {
      const icon = theme.fg("dim", "\u25CB");
      const depLabel = theme.fg("dim", `  (blockedBy: ${step.blockedBy.join(", ")})`);
      lines.push(`  ${icon} ${theme.fg("accent", step.id)}${depLabel}`);
    }
  }

  return lines;
}

// ---- Main export -----------------------------------------------------------

export interface ArchitectWidgetOptions {
  /** Resolve agent source type from name. Return "local" for project-local agents, "built-in" otherwise. */
  resolveAgentType?: (agentName: string) => "built-in" | "local";
}

export function createArchitectWidget(opts?: ArchitectWidgetOptions): {
  factory: (
    _tui: any,
    theme: any,
  ) => { render(width: number): string[]; invalidate(): void };
  setUpdateCallback(cb: () => void): void;
  onToolCall(toolName: string, input: any): void;
  onToolResult(toolName: string, output: any, isError: boolean): void;
  setReady(): void;
  getFlowContent(): string | null;
  hasFlowContent(): boolean;
  getFlowContents(): Array<{ name: string; content: string }>;
  setPreviewSubMode(mode: "preview" | "navigate"): void;
  getPreviewSubMode(): "preview" | "navigate";
  getSelectedFlowIndex(): number;
  setSelectedFlowIndex(index: number): void;
  getFlowCount(): number;
  getEventLog(): any[];
  setModel(resolvedModel: string, modelAlias: string): void;
  showPrompt(id: string, type: "select" | "input", question: string, options?: string[], signal?: AbortSignal): Promise<string | undefined>;
  clearPrompt(): void;
  handlePromptInput(data: string): boolean;
  hasActivePrompt(): boolean;
  dispose(): void;
} {
  const resolveAgentType = opts?.resolveAgentType;
  // Stash flow contents for overlay — accumulates across flow_write calls
  const flowContents: Array<{ name: string; content: string }> = [];

  // Catalog metadata — stored separately from state.agents to avoid cluttering the display
  let catalogAgentTypes = new Map<string, "built-in" | "local">();
  let catalogCount = 0;

  // Event log for detail overlay (same shape as AgentDashboard event log)
  const eventLog: Array<{ kind: string; toolName?: string; input?: any; output?: any; isError?: boolean; text?: string }> = [];

  const state: ArchitectState = {
    mode: "design",
    previewSubMode: "preview",
    selectedFlowIndex: 0,
    flowName: "",
    flowDescription: "",
    flowPath: "",
    maxConcurrent: 0,
    agents: [],
    dagSteps: [],
    parsedFlows: [],
    statusLeft: "",
    statusRight: "",
    spinFrame: 0,
    flowWritten: false,
    previewApproval: "Awaiting approval...",
    lastToolCall: null,
    architectModel: "",
    architectModelAlias: "",
    prompt: null,
    validationErrors: [],
  };

  let spinTimer: ReturnType<typeof setInterval> | null = null;
  let invalidateFn: (() => void) | null = null;
  let onUpdate: (() => void) | null = null;

  // Height ratcheting for preview mode — prevents jitter as flows are added
  let previewMinHeight = 0;

  // Track which agent is currently being created (by agent_write)
  let pendingAgentName: string | null = null;

  // -- Spinner management ---------------------------------------------------
  // The header spinner runs continuously in design mode (the architect is
  // always working even when calling non-architect tools like read/grep).
  // It only stops on preview transition or dispose.

  function startSpinner(): void {
    if (spinTimer) return;
    spinTimer = setInterval(() => {
      state.spinFrame++;
      onUpdate?.();
    }, SPINNER_INTERVAL);
  }

  function stopSpinner(): void {
    if (spinTimer) {
      clearInterval(spinTimer);
      spinTimer = null;
    }
  }

  // Start spinner immediately — architect is active from widget creation
  startSpinner();

  // -- Tool call tracking ---------------------------------------------------

  function onToolCall(toolName: string, input: any): void {
    startSpinner();

    // Record in event log for detail overlay
    eventLog.push({ kind: "tool", toolName, input, output: undefined, isError: false });

    // Track the most recent tool call for display (all tools, not just architect-specific)
    state.lastToolCall = { toolName, inputPreview: extractInputPreview(toolName, input) };

    switch (toolName) {
      case "agent_catalog":
        state.statusLeft = "Reading agent catalog\u2026";
        break;

      case "agent_write": {
        const name = extractAgentName(input);
        pendingAgentName = name;

        // Check if this agent is already in the list
        const existing = state.agents.find((a) => a.name === name);
        if (existing) {
          existing.type = "custom";  // agent_write always means custom
          existing.status = "creating";
          existing.statusText = "Writing frontmatter\u2026";
        } else {
          state.agents.push({
            name,
            type: "custom",
            status: "creating",
            statusText: "Writing frontmatter\u2026",
          });
        }

        const customCount = state.agents.filter((a) => a.type === "custom").length;
        const doneCount = state.agents.filter(
          (a) => a.type === "custom" && a.status === "done",
        ).length;
        state.statusLeft = `Creating custom agent ${doneCount + 1}/${customCount}`;
        break;
      }

      case "flow_write": {
        state.statusRight = "Writing flow\u2026";
        state.validationErrors = []; // Clear previous errors
        // Store the flow path
        if (input?.path) state.flowPath = input.path;
        // Parse and accumulate flow content
        if (input?.content) {
          const parsed = parseFlowForWidget(input.content);
          const flowName = parsed.name || "unnamed";

          // Upsert into flowContents
          const existingIdx = flowContents.findIndex((f) => f.name === flowName);
          if (existingIdx >= 0) {
            flowContents[existingIdx].content = input.content;
          } else {
            flowContents.push({ name: flowName, content: input.content });
          }

          // Upsert into parsedFlows
          const parsedEntry: ParsedFlowEntry = {
            name: flowName,
            description: parsed.description,
            maxConcurrent: parsed.maxConcurrent,
            steps: parsed.steps,
          };
          const existingParsed = state.parsedFlows.findIndex((f) => f.name === flowName);
          if (existingParsed >= 0) {
            state.parsedFlows[existingParsed] = parsedEntry;
          } else {
            state.parsedFlows.push(parsedEntry);
          }

          // Update current flow state (for design mode)
          if (parsed.name) state.flowName = parsed.name;
          if (parsed.description) state.flowDescription = parsed.description;
          if (parsed.maxConcurrent) state.maxConcurrent = parsed.maxConcurrent;
          state.dagSteps = parsed.steps;

          // Register agents from flow steps — use agent name (not step id)
          // to match agent_write entries. Also resolve source type.
          for (const step of parsed.steps) {
            const agentName = step.agentName || step.id;
            step.sourceType = catalogAgentTypes.get(agentName)
              || state.agents.find((a) => a.name === agentName)?.type
              || "built-in";
            if (!state.agents.find((a) => a.name === agentName)) {
              state.agents.push({
                name: agentName,
                type: step.sourceType as "built-in" | "local" | "custom",
                status: "done",
              });
            }
          }
        }
        break;
      }

      default:
        // Non-architect tools (read, grep, glob, bash) → show researching status
        if (!state.statusLeft || state.statusLeft === "Researching\u2026") {
          state.statusLeft = "Researching\u2026";
        }
        break;
    }

    invalidateFn?.();
  }

  function onToolResult(
    toolName: string,
    output: any,
    isError: boolean,
  ): void {
    // Update last tool entry in event log
    for (let i = eventLog.length - 1; i >= 0; i--) {
      if (eventLog[i].kind === "tool" && eventLog[i].output === undefined) {
        eventLog[i].output = output;
        eventLog[i].isError = isError;
        break;
      }
    }
    switch (toolName) {
      case "agent_catalog": {
        // Store catalog metadata for source type resolution — don't add to display list
        try {
          const catalog = typeof output === "string" ? JSON.parse(output) : output;
          if (Array.isArray(catalog)) {
            catalogCount = catalog.length;
            const typeCounts = new Map<string, number>();
            for (const entry of catalog) {
              if (entry.name) {
                const agentType = resolveAgentType ? resolveAgentType(entry.name) : "built-in";
                catalogAgentTypes.set(entry.name, agentType);
                const sourceType = entry.source_type || agentType;
                typeCounts.set(sourceType, (typeCounts.get(sourceType) || 0) + 1);
              }
            }
            // Build grouped count string: "18 built-in · 3 local · 2 package"
            if (catalogCount === 0) {
              state.statusLeft = "Catalog: 0 agents";
            } else {
              const parts: string[] = [];
              for (const type of ["built-in", "local", "package"] as const) {
                const count = typeCounts.get(type);
                if (count) parts.push(`${count} ${type}`);
              }
              state.statusLeft = `Catalog: ${parts.length > 0 ? parts.join(" \u00B7 ") : `${catalogCount} agents`}`;
            }
          }
        } catch {
          // Non-critical — catalog may be in unexpected format
        }
        break;
      }

      case "agent_write": {
        const name = pendingAgentName;
        pendingAgentName = null;
        if (name) {
          const entry = state.agents.find((a) => a.name === name);
          if (entry) {
            entry.status = isError ? "error" : "done";
            entry.statusText = isError ? "Failed" : undefined;
          }
        }
        const customCount = state.agents.filter((a) => a.type === "custom").length;
        const doneCount = state.agents.filter(
          (a) => a.type === "custom" && a.status === "done",
        ).length;
        if (doneCount === customCount) {
          state.statusLeft = "";
        } else {
          state.statusLeft = `Creating custom agent ${doneCount + 1}/${customCount}`;
        }
        break;
      }

      case "flow_write": {
        if (isError) {
          state.statusRight = "Write failed";
          // Parse validation diagnostics from the output
          try {
            const parsed = typeof output === "string" ? JSON.parse(output) : output;
            if (parsed?.diagnostics && Array.isArray(parsed.diagnostics)) {
              state.validationErrors = parsed.diagnostics;
            }
          } catch { /* non-JSON output — no diagnostics */ }
        } else {
          state.flowWritten = true;
          state.validationErrors = [];
          state.statusRight = "\u2713 Written";
          // Check for warnings even on success
          try {
            const parsed = typeof output === "string" ? JSON.parse(output) : output;
            if (parsed?.diagnostics && Array.isArray(parsed.diagnostics)) {
              const warnings = parsed.diagnostics.filter((d: any) => d.severity === "warning");
              if (warnings.length > 0) {
                state.validationErrors = warnings;
                state.statusRight = `\u2713 Written (${warnings.length} warning${warnings.length !== 1 ? "s" : ""})`;
              }
            }
          } catch { /* ignore */ }
          // Transition to preview mode — the widget shows the structured view
          // while ctx.ui.select() asks the bare question below
          state.mode = "preview";
          state.previewSubMode = "preview";
          stopSpinner();
        }
        break;
      }

      default:
        // Non-architect tool completed — clear "Researching…" if it was set
        if (state.statusLeft === "Researching\u2026") {
          state.statusLeft = "";
        }
        break;
    }

    // In design mode, keep the spinner running — the architect is always
    // working even between architect-specific tool calls (read/grep/glob).
    // Spinner is only stopped on preview transition or dispose.

    invalidateFn?.();
  }

  // -- Factory (setWidget-compatible) ----------------------------------------

  function factory(_tui: any, theme: any) {
    const text = new Text("", 0, 1);

    function render(width: number): string[] {
      const w = width - 2; // inner width (excluding box borders)
      if (w < 10) return [];

      const bord = (s: string) => theme.fg("dim", s);
      const spinner =
        SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length];

      const lines: string[] = [];

      if (state.mode === "design") {
        // -- Design mode layout -----------------------------------------------

        // Top border with title
        const title = " Flow Architect ";
        const titleLen = title.length;
        const afterTitle = w - titleLen - 1; // -1 for the dash before title
        lines.push(
          bord("\u250C\u2500") +
            theme.fg("accent", title) +
            bord("\u2500".repeat(Math.max(0, afterTitle)) + "\u2510"),
        );

        // Header: spinner + "Designing flow: <name>"
        const flowLabel = state.flowName || "...";
        const headerText = ` ${theme.fg("accent", spinner)} Designing flow: ${theme.fg("accent", flowLabel)}`;
        const headerVis = 1 + 1 + 1 + "Designing flow: ".length + flowLabel.length;
        lines.push(
          bord("\u2502") + headerText + " ".repeat(Math.max(0, w - headerVis)) + bord("\u2502"),
        );

        // Model info line (or empty line if no model yet)
        if (state.architectModel) {
          const displayModel = state.architectModel.split("/").pop() ?? state.architectModel;
          const hasAlias = state.architectModelAlias.startsWith("@");
          const modelStr = hasAlias
            ? ` ${theme.fg("dim", displayModel)}  ${theme.fg("muted", state.architectModelAlias)}`
            : ` ${theme.fg("dim", displayModel)}`;
          const modelVis = hasAlias
            ? 1 + displayModel.length + 2 + state.architectModelAlias.length
            : 1 + displayModel.length;
          lines.push(
            bord("\u2502") + modelStr + " ".repeat(Math.max(0, w - modelVis)) + bord("\u2502"),
          );
        } else {
          lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));
        }

        // -- Agents section ---------------------------------------------------
        if (state.agents.length > 0) {
          const agentsLabel = " Agents:";
          lines.push(
            bord("\u2502") +
              theme.fg("dim", agentsLabel) +
              " ".repeat(Math.max(0, w - agentsLabel.length)) +
              bord("\u2502"),
          );

          for (const agent of state.agents) {
            const icon =
              agent.status === "creating"
                ? theme.fg("accent", SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length])
                : agent.status === "done"
                  ? theme.fg("success", "\u2713")
                  : agent.status === "error"
                    ? theme.fg("error", "\u2717")
                    : theme.fg("dim", "\u25CB");

            const typeLabel =
              agent.type === "custom"
                ? theme.fg("dim", "(custom)")
                : agent.type === "local"
                  ? theme.fg("dim", "(local)")
                  : theme.fg("dim", "(built-in)");

            const statusLabel =
              agent.status === "creating" && agent.statusText
                ? "  " + theme.fg("dim", agent.statusText)
                : "";

            const prefix =
              agent.status === "creating"
                ? `   ${icon} Creating: ${theme.fg("accent", agent.name)}  ${typeLabel}${statusLabel}`
                : `   ${icon} ${theme.fg("accent", agent.name)}  ${typeLabel}${statusLabel}`;

            // Calculate visible length for padding
            const nameDisplay = agent.status === "creating"
              ? `Creating: ${agent.name}`
              : agent.name;
            const visLen =
              3 + // "   "
              1 + // icon
              1 + // space
              nameDisplay.length +
              2 + // "  "
              (agent.type === "custom" ? 8 : agent.type === "local" ? 7 : 10) + // "(custom)" 8, "(local)" 7, "(built-in)" 10
              (agent.status === "creating" && agent.statusText
                ? 2 + agent.statusText.length
                : 0);

            const truncLen = Math.min(visLen, w);
            lines.push(
              bord("\u2502") + prefix + " ".repeat(Math.max(0, w - truncLen)) + bord("\u2502"),
            );
          }

          // Empty line after agents
          lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));
        }

        // -- DAG section ------------------------------------------------------
        if (state.dagSteps.length > 0) {
          const flowLabel2 = " Flow:";
          lines.push(
            bord("\u2502") +
              theme.fg("dim", flowLabel2) +
              " ".repeat(Math.max(0, w - flowLabel2.length)) +
              bord("\u2502"),
          );

          const dagLines = renderDag(state.dagSteps, theme);
          for (const dagLine of dagLines) {
            const vw = visibleWidth(dagLine);
            const pad = Math.max(0, w - vw);
            lines.push(bord("\u2502") + dagLine + " ".repeat(pad) + bord("\u2502"));
          }

          // Empty line after DAG
          lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));
        }

        // -- Validation errors section ----------------------------------------
        if (state.validationErrors.length > 0) {
          const errLabel = " Validation:";
          lines.push(
            bord("\u2502") +
              theme.fg("error", errLabel) +
              " ".repeat(Math.max(0, w - errLabel.length)) +
              bord("\u2502"),
          );
          for (const diag of state.validationErrors.slice(0, 5)) {
            const icon = diag.severity === "error" ? theme.fg("error", "\u2717") : theme.fg("accent", "\u26A0");
            const lineRef = diag.line > 0 ? theme.fg("dim", `L${diag.line}: `) : "";
            const msgText = `   ${icon} ${lineRef}${diag.message}`;
            const msgVis = 3 + 2 + (diag.line > 0 ? `L${diag.line}: `.length : 0) + diag.message.length;
            const truncMsg = msgVis > w ? msgText.slice(0, w) : msgText;
            const truncVis = Math.min(msgVis, w);
            lines.push(
              bord("\u2502") + truncMsg + " ".repeat(Math.max(0, w - truncVis)) + bord("\u2502"),
            );
          }
          if (state.validationErrors.length > 5) {
            const moreText = `   ... +${state.validationErrors.length - 5} more`;
            const moreVis = moreText.length;
            lines.push(
              bord("\u2502") + theme.fg("dim", moreText) + " ".repeat(Math.max(0, w - moreVis)) + bord("\u2502"),
            );
          }
          lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));
        }

        // -- Tool call line ---------------------------------------------------
        if (state.lastToolCall) {
          const tcLine = ` \u25B8 ${state.lastToolCall.toolName} ${state.lastToolCall.inputPreview}`;
          const tcVis = 1 + 2 + state.lastToolCall.toolName.length + 1 + state.lastToolCall.inputPreview.length;
          const tcTrunc = tcLine.slice(0, w);
          const tcTruncVis = Math.min(tcVis, w);
          lines.push(
            bord("\u2502") +
              theme.fg("dim", tcTrunc) +
              " ".repeat(Math.max(0, w - tcTruncVis)) +
              bord("\u2502"),
          );
        }

        // -- Status bar -------------------------------------------------------
        const left = state.statusLeft
          ? " " + state.statusLeft
          : "";
        const right = state.statusRight || "";
        const separator = right ? " \u2502 " : "";
        const statusVis = left.length + separator.length + right.length;
        const statusPad = Math.max(0, w - statusVis);
        lines.push(
          bord("\u2502") +
            theme.fg("dim", left) +
            (right ? theme.fg("dim", separator) + theme.fg("accent", right) : "") +
            " ".repeat(statusPad) +
            bord("\u2502"),
        );

        // -- Keyboard hints ---------------------------------------------------
        {
          const hints: string[] = ["Ctrl+X stop", "Ctrl+O inspect"];
          const hintText = " " + hints.join(" \u00B7 ");
          const hintVis = hintText.length;
          lines.push(
            bord("\u2502") +
              theme.fg("dim", hintText) +
              " ".repeat(Math.max(0, w - hintVis)) +
              bord("\u2502"),
          );
        }

        // Bottom border
        lines.push(bord("\u2514" + "\u2500".repeat(w) + "\u2518"));
      } else if (state.previewSubMode === "navigate") {
        // -- Navigate mode: flow selector list --------------------------------

        const content: string[] = [];

        // Header
        content.push(theme.fg("accent", `${state.parsedFlows.length} flow${state.parsedFlows.length !== 1 ? "s" : ""} \u00B7 Select flow to inspect`));

        for (let i = 0; i < state.parsedFlows.length; i++) {
          const pf = state.parsedFlows[i];
          const sel = i === state.selectedFlowIndex ? ">" : " ";
          const stepCount = pf.steps.length;
          const meta = pf.maxConcurrent ? ` \u2502 max concurrent: ${pf.maxConcurrent}` : "";
          content.push(`${sel} ${theme.fg("accent", "\u25C7")} ${theme.fg("accent", pf.name)} ${theme.fg("dim", `(${stepCount} step${stepCount !== 1 ? "s" : ""}${meta})`)}`);
        }

        const boxLines = renderBox({
          width,
          theme,
          title: "Flow Preview",
          content,
          separatorAfter: [0],
          footer: [theme.fg("dim", "\u2191\u2193 navigate \u00B7 Enter inspect \u00B7 Backspace back")],
        });
        lines.push(...boxLines);
      } else {
        // -- Preview mode layout \u2014 truncated multi-flow view -------------------

        const content: string[] = [];
        const separators: number[] = [];

        const spinnerActive = spinTimer !== null;
        const spinnerStr = spinnerActive
          ? theme.fg("accent", SPINNER_FRAMES[state.spinFrame % SPINNER_FRAMES.length]) + " "
          : "";

        const flows = state.parsedFlows;

        for (let fi = 0; fi < flows.length; fi++) {
          const pf = flows[fi];

          // Flow header: name + metadata
          const stepCount = pf.steps.length;
          const metaParts: string[] = [`${stepCount} step${stepCount !== 1 ? "s" : ""}`];
          if (pf.maxConcurrent) metaParts.push(`max concurrent: ${pf.maxConcurrent}`);
          const prefix = fi === 0 ? spinnerStr : "";
          content.push(`${prefix}${theme.fg("accent", "\u25C7")} ${theme.fg("accent", pf.name)}  ${theme.fg("dim", metaParts.join(" \u2502 "))}`);

          // Truncated step chain: \u25CB step1 \u2192 \u25CB step2 \u2192 ...
          if (pf.steps.length > 0) {
            const chainMaxW = w - 4; // padding
            let chain = "";
            let shown = 0;
            for (const step of pf.steps) {
              const segment = (shown > 0 ? " \u2192 " : "") + `\u25CB ${step.id}`;
              if (chain.length + segment.length > chainMaxW && shown > 0) {
                const remaining = pf.steps.length - shown;
                chain += theme.fg("dim", ` ... +${remaining} more`);
                break;
              }
              chain += theme.fg("dim", shown > 0 ? " \u2192 " : "") + theme.fg("dim", "\u25CB") + " " + theme.fg("muted", step.id);
              shown++;
            }
            content.push(`  ${chain}`);
          }

          // Add separator between flows (but not after the last one)
          if (fi < flows.length - 1) {
            separators.push(content.length - 1);
          }
        }

        // -- Validation errors in preview mode ---------------------------------
        if (state.validationErrors.length > 0) {
          separators.push(content.length - 1);
          const hasErrors = state.validationErrors.some(d => d.severity === "error");
          const errCount = state.validationErrors.filter(d => d.severity === "error").length;
          const warnCount = state.validationErrors.filter(d => d.severity === "warning").length;
          const summaryParts: string[] = [];
          if (errCount > 0) summaryParts.push(theme.fg("error", `${errCount} error${errCount !== 1 ? "s" : ""}`));
          if (warnCount > 0) summaryParts.push(theme.fg("accent", `${warnCount} warning${warnCount !== 1 ? "s" : ""}`));
          content.push(` ${hasErrors ? theme.fg("error", "\u2717 Flow Invalid:") : theme.fg("accent", "\u26A0 Warnings:")} ${summaryParts.join(", ")}`);
          for (const diag of state.validationErrors.slice(0, 3)) {
            const icon = diag.severity === "error" ? theme.fg("error", "\u2717") : theme.fg("accent", "\u26A0");
            const lineRef = diag.line > 0 ? theme.fg("dim", `L${diag.line}: `) : "";
            content.push(`   ${icon} ${lineRef}${diag.message}`);
          }
          if (state.validationErrors.length > 3) {
            content.push(theme.fg("dim", `   ... +${state.validationErrors.length - 3} more`));
          }
        }

        // -- Inline prompt (Save/Replan or input) ------------------------------
        if (state.prompt) {
          separators.push(content.length - 1);
          content.push(theme.fg("accent", ` ${state.prompt.question}`));

          if (state.prompt.type === "select" && state.prompt.options) {
            for (let oi = 0; oi < state.prompt.options.length; oi++) {
              const opt = state.prompt.options[oi];
              const selected = oi === state.prompt.selectedIndex;
              const marker = selected ? theme.fg("accent", ">") : " ";
              const label = selected ? theme.fg("accent", opt) : theme.fg("muted", opt);
              content.push(`   ${marker} ${label}`);
            }
          } else if (state.prompt.type === "input") {
            const cursor = theme.fg("accent", "\u2588");
            content.push(`   ${theme.fg("muted", ">")} ${state.prompt.inputValue}${cursor}`);
          }
        }

        const hintParts: string[] = [];
        if (state.prompt) {
          if (state.prompt.type === "select") {
            hintParts.push("\u2191\u2193 select", "Enter confirm", "1-9 quick select");
          } else {
            hintParts.push("Enter submit", "Esc cancel");
          }
        } else {
          hintParts.push("Ctrl+X stop", "Ctrl+O inspect");
          if (flows.length > 1) hintParts[1] = "Ctrl+O inspect flows";
        }

        const boxLines = renderBox({
          width,
          theme,
          title: "Flow Preview",
          content,
          separatorAfter: separators,
          footer: [theme.fg("dim", hintParts.join(" \u00B7 "))],
        });
        lines.push(...boxLines);
      }

      // Height ratcheting: pad to prevent jitter when flows are added
      if (state.mode === "preview") {
        if (lines.length > previewMinHeight) previewMinHeight = lines.length;
        while (lines.length < previewMinHeight) lines.push("");
      }

      // Use Text component for ANSI-aware width padding
      text.setText(lines.join("\n"));
      return text.render(width);
    }

    function invalidate(): void {
      text.invalidate();
    }

    // Store invalidate ref so the timer can trigger re-renders
    invalidateFn = invalidate;

    return { render, invalidate };
  }

  // -- Dispose ---------------------------------------------------------------

  function setUpdateCallback(cb: () => void): void {
    onUpdate = cb;
  }

  function dispose(): void {
    stopSpinner();
    invalidateFn = null;
    onUpdate = null;
  }

  function setReady(): void {
    stopSpinner();
    state.previewApproval = "";
    invalidateFn?.();
  }

  function getFlowContent(): string | null {
    return flowContents.length > 0 ? flowContents[flowContents.length - 1].content : null;
  }

  function hasFlowContent(): boolean {
    return flowContents.length > 0;
  }

  function getFlowContents(): Array<{ name: string; content: string }> {
    return flowContents;
  }

  function setPreviewSubMode(mode: "preview" | "navigate"): void {
    state.previewSubMode = mode;
    if (mode === "navigate") {
      state.selectedFlowIndex = 0;
    }
    invalidateFn?.();
  }

  function getPreviewSubMode(): "preview" | "navigate" {
    return state.previewSubMode;
  }

  function getSelectedFlowIndex(): number {
    return state.selectedFlowIndex;
  }

  function setSelectedFlowIndex(index: number): void {
    state.selectedFlowIndex = Math.max(0, Math.min(index, state.parsedFlows.length - 1));
    invalidateFn?.();
  }

  function getFlowCount(): number {
    return flowContents.length;
  }

  function onAssistantText(text: string): void {
    if (!text) return;
    eventLog.push({ kind: "text", text });
  }

  function onThinkingText(text: string): void {
    if (!text) return;
    eventLog.push({ kind: "thinking", text });
  }

  function getEventLog(): any[] {
    return eventLog;
  }

  function setModel(resolvedModel: string, modelAlias: string): void {
    state.architectModel = resolvedModel;
    state.architectModelAlias = modelAlias;
  }

  // -- Inline prompt support ------------------------------------------------

  /** Callback invoked when the user answers the prompt in the widget */
  let promptResolveFn: ((answer: string | undefined) => void) | null = null;

  /**
   * Show an inline prompt in the widget (replaces ctx.ui.select/input).
   * Returns a promise that resolves with the answer, or undefined if dismissed.
   */
  function showPrompt(
    id: string,
    type: "select" | "input",
    question: string,
    options?: string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    state.prompt = {
      id,
      type,
      question,
      options,
      selectedIndex: 0,
      inputValue: "",
    };
    invalidateFn?.();
    onUpdate?.();

    return new Promise<string | undefined>((resolve) => {
      promptResolveFn = resolve;

      if (signal) {
        const onAbort = () => {
          if (state.prompt?.id === id) {
            state.prompt = null;
            promptResolveFn = null;
            invalidateFn?.();
            onUpdate?.();
          }
          resolve(undefined);
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Clear the prompt (e.g., when answered from dashboard) */
  function clearPrompt(): void {
    state.prompt = null;
    if (promptResolveFn) {
      promptResolveFn(undefined);
      promptResolveFn = null;
    }
    invalidateFn?.();
    onUpdate?.();
  }

  /** Handle keyboard input for the active prompt. Returns true if consumed. */
  function handlePromptInput(data: string): boolean {
    if (!state.prompt) return false;

    if (state.prompt.type === "select" && state.prompt.options) {
      const opts = state.prompt.options;
      if (data === "\x1B[A" || data === "k") { // Up arrow or k
        state.prompt.selectedIndex = Math.max(0, state.prompt.selectedIndex - 1);
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      if (data === "\x1B[B" || data === "j") { // Down arrow or j
        state.prompt.selectedIndex = Math.min(opts.length - 1, state.prompt.selectedIndex + 1);
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      if (data === "\r" || data === "\n") { // Enter
        const answer = opts[state.prompt.selectedIndex];
        state.prompt = null;
        if (promptResolveFn) {
          promptResolveFn(answer);
          promptResolveFn = null;
        }
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      // Number keys for quick selection
      const num = parseInt(data, 10);
      if (num >= 1 && num <= opts.length) {
        const answer = opts[num - 1];
        state.prompt = null;
        if (promptResolveFn) {
          promptResolveFn(answer);
          promptResolveFn = null;
        }
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      return true; // Consume all input while select prompt is active
    }

    if (state.prompt.type === "input") {
      if (data === "\r" || data === "\n") { // Enter — submit
        const answer = state.prompt.inputValue;
        state.prompt = null;
        if (promptResolveFn) {
          promptResolveFn(answer);
          promptResolveFn = null;
        }
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      if (data === "\x1B" || data === "\x03") { // Escape or Ctrl+C — cancel
        state.prompt = null;
        if (promptResolveFn) {
          promptResolveFn(undefined);
          promptResolveFn = null;
        }
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      if (data === "\x7F" || data === "\b") { // Backspace
        state.prompt.inputValue = state.prompt.inputValue.slice(0, -1);
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      // Regular character input
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        state.prompt.inputValue += data;
        invalidateFn?.();
        onUpdate?.();
        return true;
      }
      return true;
    }

    return false;
  }

  /** Check if a prompt is active */
  function hasActivePrompt(): boolean {
    return state.prompt !== null;
  }

  return { factory, setUpdateCallback, onToolCall, onToolResult, setReady, onAssistantText, onThinkingText, getFlowContent, hasFlowContent, getFlowContents, setPreviewSubMode, getPreviewSubMode, getSelectedFlowIndex, setSelectedFlowIndex, getFlowCount, getEventLog, setModel, showPrompt, clearPrompt, handlePromptInput, hasActivePrompt, dispose };
}
