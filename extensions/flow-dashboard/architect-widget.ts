// ---------------------------------------------------------------------------
// Flow Architect Design Widget
//
// Full-width TUI component rendered above the editor during the Flow
// Architect's design phase.  Tracks tool calls (agent_catalog, agent_write,
// flow_validate, flow_write, flow_preview) and renders a live-updating
// box showing:
//   - Spinner + flow name header
//   - Agent list (built-in vs custom, with creation progress)
//   - DAG visualization of flow steps
//   - Status bar with current activity
//   - Preview mode when flow_preview is called
// ---------------------------------------------------------------------------

import { Text } from "@mariozechner/pi-tui";

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
  blockedBy: string[];
  task: string;
  sourceType: "built-in" | "local" | "custom";
}

// ---- Widget mode -----------------------------------------------------------

type WidgetMode = "design" | "preview";

// ---- Internal state --------------------------------------------------------

interface ArchitectState {
  mode: WidgetMode;
  flowName: string;
  flowDescription: string;
  flowPath: string;
  maxConcurrent: number;
  agents: AgentEntry[];
  dagSteps: DagStep[];
  statusLeft: string;
  statusRight: string;
  spinFrame: number;
  validationErrors: number;
  flowWritten: boolean;
  previewApproval: string; // e.g., "Awaiting approval..."
  lastToolCall: { toolName: string; inputPreview: string } | null;
}

// ---- Flow content parser (lightweight — extracts steps + blockedBy) --------

function parseFlowSteps(content: string): { name: string; description: string; maxConcurrent: number; steps: DagStep[] } {
  const lines = content.split("\n");
  let name = "";
  let description = "";
  let maxConcurrent = 0;
  const steps: DagStep[] = [];

  // Extract frontmatter fields
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  if (nameMatch) name = nameMatch[1].trim();
  const descMatch = content.match(/^description:\s*(.+)$/m);
  if (descMatch) description = descMatch[1].trim();
  const concMatch = content.match(/^max_concurrent:\s*(\d+)$/m);
  if (concMatch) maxConcurrent = parseInt(concMatch[1], 10);

  // Extract step headers, blockedBy, and task
  let currentStepId: string | null = null;

  const validPrefixes = ["fork:", "conditional:", "agent-decision:", "agent-loop-decision:", "flow-ref:"];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      const header = headerMatch[1].trim();
      const isSpecial = validPrefixes.some((p) => header.startsWith(p));
      if (isSpecial) {
        const colonIdx = header.indexOf(":");
        currentStepId = header.slice(colonIdx + 1).trim();
      } else {
        currentStepId = header;
      }
      steps.push({ id: currentStepId, blockedBy: [], task: "", sourceType: "built-in" });
      continue;
    }

    if (currentStepId) {
      const last = steps[steps.length - 1];
      if (last) {
        const blockedByMatch = line.match(/^blockedBy:\s*(.+)$/);
        if (blockedByMatch) {
          last.blockedBy = blockedByMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        const taskMatch = line.match(/^task:\s*(.+)$/);
        if (taskMatch) {
          last.task = taskMatch[1].trim();
        }
      }
    }
  }

  return { name, description, maxConcurrent, steps };
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
  getFlowContent(): string | null;
  hasFlowContent(): boolean;
  dispose(): void;
} {
  const resolveAgentType = opts?.resolveAgentType;
  // Stash flow content for overlay — updated on flow_write/flow_preview
  let lastFlowContent: string | null = null;

  const state: ArchitectState = {
    mode: "design",
    flowName: "",
    flowDescription: "",
    flowPath: "",
    maxConcurrent: 0,
    agents: [],
    dagSteps: [],
    statusLeft: "",
    statusRight: "",
    spinFrame: 0,
    validationErrors: 0,
    flowWritten: false,
    previewApproval: "Awaiting approval...",
    lastToolCall: null,
  };

  let spinTimer: ReturnType<typeof setInterval> | null = null;
  let invalidateFn: (() => void) | null = null;
  let onUpdate: (() => void) | null = null;

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

      case "flow_validate":
        state.statusRight = "Validating\u2026";
        break;

      case "flow_write": {
        state.statusRight = "Writing flow\u2026";
        // Store the flow path
        if (input?.path) state.flowPath = input.path;
        // Stash raw flow content for overlay
        if (input?.content) lastFlowContent = input.content;
        // Parse steps from the content
        if (input?.content) {
          const parsed = parseFlowSteps(input.content);
          if (parsed.name) state.flowName = parsed.name;
          if (parsed.description) state.flowDescription = parsed.description;
          if (parsed.maxConcurrent) state.maxConcurrent = parsed.maxConcurrent;
          state.dagSteps = parsed.steps;

          // Register any agents mentioned in the flow that aren't already tracked
          // and mark source type on steps
          const agentTypeMap = new Map(state.agents.map((a) => [a.name, a.type]));
          for (const step of parsed.steps) {
            step.sourceType = agentTypeMap.get(step.id) || "built-in";
            if (!state.agents.find((a) => a.name === step.id)) {
              state.agents.push({
                name: step.id,
                type: "built-in",
                status: "pending",
              });
            }
          }
        }
        break;
      }

      case "flow_preview":
        // Stash raw flow content for overlay
        if (input?.content) lastFlowContent = input.content;
        // Parse preview content to update DAG if available
        if (input?.content) {
          const parsed = parseFlowSteps(input.content);
          if (parsed.name) state.flowName = parsed.name;
          if (parsed.description) state.flowDescription = parsed.description;
          state.dagSteps = parsed.steps;
        }
        // Transition to preview mode
        state.mode = "preview";
        state.previewApproval = "Awaiting approval\u2026";
        break;

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
    switch (toolName) {
      case "agent_catalog": {
        state.statusLeft = "";
        // Populate agents from the catalog result, resolving source type
        try {
          const catalog = typeof output === "string" ? JSON.parse(output) : output;
          if (Array.isArray(catalog)) {
            for (const entry of catalog) {
              if (entry.name && !state.agents.find((a) => a.name === entry.name)) {
                const agentType = resolveAgentType ? resolveAgentType(entry.name) : "built-in";
                state.agents.push({
                  name: entry.name,
                  type: agentType,
                  status: "done",
                });
              }
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

      case "flow_validate": {
        if (isError) {
          state.statusRight = "Validation failed";
        } else {
          try {
            const result = typeof output === "string" ? JSON.parse(output) : output;
            const errors = (result?.diagnostics || []).filter(
              (d: any) => d.severity === "error",
            ).length;
            state.validationErrors = errors;
            state.statusRight =
              errors > 0
                ? `${errors} error${errors > 1 ? "s" : ""}`
                : "\u2713 Valid";
          } catch {
            state.statusRight = "\u2713 Valid";
          }
        }
        break;
      }

      case "flow_write": {
        if (isError) {
          state.statusRight = "Write failed";
        } else {
          state.flowWritten = true;
          state.statusRight = "\u2713 Written";
          // Transition to preview mode — the widget shows the structured view
          // while ctx.ui.select() asks the bare question below
          state.mode = "preview";
          stopSpinner();
        }
        break;
      }

      case "flow_preview":
        // Preview result includes user's choice — keep in preview mode
        if (isError) {
          state.previewApproval = "Preview failed";
        }
        // Stop spinner since preview is now waiting for user action
        stopSpinner();
        break;

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

        // Empty line
        lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));

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
            // DAG lines already have leading spaces; just pad to width
            // We can't easily compute visible length of themed strings,
            // so we delegate to Text for padding below.
            lines.push(bord("\u2502") + dagLine);
          }

          // Empty line after DAG
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
          ? " Status: " + state.statusLeft
          : " Status: idle";
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
          const hints: string[] = ["Ctrl+X stop"];
          if (lastFlowContent) hints.push("Ctrl+O inspect flow");
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
      } else {
        // -- Preview mode layout — rich structured view -----------------------

        const MAX_VISIBLE_STEPS = 8;

        // Top border with title
        const title = " Flow Preview ";
        const titleLen = title.length;
        const afterTitle = w - titleLen - 1;
        lines.push(
          bord("\u250C\u2500") +
            theme.fg("accent", title) +
            bord("\u2500".repeat(Math.max(0, afterTitle)) + "\u2510"),
        );

        // Header: flow name + description + metadata
        const flowLabel = state.flowName || "unnamed";
        const nameStr = ` ${theme.fg("accent", flowLabel)}`;
        const nameVis = 1 + flowLabel.length;
        lines.push(
          bord("\u2502") + nameStr + " ".repeat(Math.max(0, w - nameVis)) + bord("\u2502"),
        );

        if (state.flowDescription) {
          const descStr = ` ${state.flowDescription}`;
          const descTrunc = descStr.length > w ? descStr.slice(0, w - 3) + "..." : descStr;
          const descVis = Math.min(descStr.length, w);
          lines.push(
            bord("\u2502") +
              theme.fg("muted", descTrunc) +
              " ".repeat(Math.max(0, w - descVis)) +
              bord("\u2502"),
          );
        }

        // Metadata line: step count, concurrency, file path
        const stepCount = state.dagSteps.length;
        const metaParts: string[] = [`${stepCount} step${stepCount !== 1 ? "s" : ""}`];
        if (state.maxConcurrent) metaParts.push(`max concurrent: ${state.maxConcurrent}`);
        const metaLine = ` ${metaParts.join(" \u2502 ")}`;
        const metaVis = metaLine.length;
        lines.push(
          bord("\u2502") +
            theme.fg("dim", metaLine) +
            " ".repeat(Math.max(0, w - metaVis)) +
            bord("\u2502"),
        );

        if (state.flowPath) {
          const pathLine = ` File: ${state.flowPath}`;
          const pathTrunc = pathLine.length > w ? pathLine.slice(0, w - 3) + "..." : pathLine;
          const pathVis = Math.min(pathLine.length, w);
          lines.push(
            bord("\u2502") +
              theme.fg("dim", pathTrunc) +
              " ".repeat(Math.max(0, w - pathVis)) +
              bord("\u2502"),
          );
        }

        // Separator
        lines.push(bord("\u2502\u2500" + "\u2500".repeat(Math.max(0, w - 2)) + "\u2500\u2502"));

        // -- Steps section ----------------------------------------------------
        if (state.dagSteps.length > 0) {
          const visibleSteps = state.dagSteps.slice(0, MAX_VISIBLE_STEPS);
          const remaining = state.dagSteps.length - visibleSteps.length;

          for (let i = 0; i < visibleSteps.length; i++) {
            const step = visibleSteps[i];
            const num = `${i + 1}.`;
            const typeTag = step.sourceType === "custom" ? "(custom)" : step.sourceType === "local" ? "(local)" : "(built-in)";
            const stepHeader = ` ${num} ${theme.fg("accent", step.id)}  ${theme.fg("dim", typeTag)}`;
            const stepHeaderVis = 1 + num.length + 1 + step.id.length + 2 + typeTag.length;
            lines.push(
              bord("\u2502") + stepHeader + " ".repeat(Math.max(0, w - stepHeaderVis)) + bord("\u2502"),
            );

            // Task description (wrapped to width)
            if (step.task) {
              const indent = "    ";
              const maxTaskW = w - indent.length;
              const taskWords = step.task.split(/\s+/);
              let taskLine = "";
              for (const word of taskWords) {
                if (taskLine.length + word.length + 1 > maxTaskW) {
                  const tl = indent + taskLine;
                  const tlVis = tl.length;
                  lines.push(
                    bord("\u2502") + theme.fg("muted", tl) + " ".repeat(Math.max(0, w - tlVis)) + bord("\u2502"),
                  );
                  taskLine = word;
                } else {
                  taskLine = taskLine ? taskLine + " " + word : word;
                }
              }
              if (taskLine) {
                const tl = indent + taskLine;
                const tlVis = tl.length;
                lines.push(
                  bord("\u2502") + theme.fg("muted", tl) + " ".repeat(Math.max(0, w - tlVis)) + bord("\u2502"),
                );
              }
            }

            // Dependencies
            if (step.blockedBy.length > 0) {
              const depLine = `    blockedBy: ${step.blockedBy.join(", ")}`;
              const depTrunc = depLine.length > w ? depLine.slice(0, w - 3) + "..." : depLine;
              const depVis = Math.min(depLine.length, w);
              lines.push(
                bord("\u2502") + theme.fg("dim", depTrunc) + " ".repeat(Math.max(0, w - depVis)) + bord("\u2502"),
              );
            }

            // Empty line between steps (except last)
            if (i < visibleSteps.length - 1) {
              lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));
            }
          }

          if (remaining > 0) {
            const moreLine = `    ... and ${remaining} more step${remaining > 1 ? "s" : ""}`;
            const moreVis = moreLine.length;
            lines.push(
              bord("\u2502") + theme.fg("dim", moreLine) + " ".repeat(Math.max(0, w - moreVis)) + bord("\u2502"),
            );
          }

          // Empty line before DAG
          lines.push(bord("\u2502") + " ".repeat(w) + bord("\u2502"));
        }

        // -- Dependency tree --------------------------------------------------
        if (state.dagSteps.length > 1) {
          const dagLabel = " Dependency Graph:";
          lines.push(
            bord("\u2502") +
              theme.fg("dim", dagLabel) +
              " ".repeat(Math.max(0, w - dagLabel.length)) +
              bord("\u2502"),
          );

          const dagLines = renderDag(state.dagSteps, theme);
          for (const dagLine of dagLines) {
            lines.push(bord("\u2502") + dagLine);
          }
        }

        // -- Keyboard hints ---------------------------------------------------
        {
          const hintText = " Ctrl+X stop \u00B7 Ctrl+O inspect full flow";
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

  function getFlowContent(): string | null {
    return lastFlowContent;
  }

  function hasFlowContent(): boolean {
    return lastFlowContent !== null;
  }

  return { factory, setUpdateCallback, onToolCall, onToolResult, getFlowContent, hasFlowContent, dispose };
}
