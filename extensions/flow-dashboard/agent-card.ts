import type { CardStatus, AgentCardRenderer } from "./types.js";
import type { AgentResult } from "../flow-engine/types.js";
import { visibleWidth } from "@mariozechner/pi-tui";

/** Format token count in compact "k" notation. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return Math.round(n / 1000) + "k";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Extract a short input preview for the last tool call line. */
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

const MAX_RECENT_TOOLS = 3;

/** Truncate a string to fit within `limit` chars, appending "..." if cut. */
function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, Math.max(0, limit - 3)) + "...";
}

/** Strip newlines/carriage returns, replacing with spaces. */
function sanitize(s: string): string {
  return s.replace(/[\n\r]+/g, " ");
}

export class AgentCard {
  public spinFrame = 0;
  public modelRole = "";
  public cardRole = "";  // From CardConfig.role (takes priority over modelRole for display)
  public label = "";
  public blockedByNames: string[] = [];
  public tokens: { input: number; output: number } = { input: 0, output: 0 };
  public duration = 0;
  public loopIteration = 0;
  public loopMax = 0;
  private recentTools: { toolName: string; inputPreview: string }[] = [];

  constructor(
    public agentName: string,
    public status: CardStatus,
    public renderer: AgentCardRenderer,
  ) {}

  onComplete(result: AgentResult): void {
    this.tokens = result.tokens;
    this.duration = result.duration;
  }

  onToolCall(toolName: string, input: any): void {
    this.recentTools.push({ toolName, inputPreview: sanitize(extractInputPreview(toolName, input)) });
    if (this.recentTools.length > MAX_RECENT_TOOLS) this.recentTools.shift();
  }

  render(width: number, theme: any, selected = false): string[] {
    const w = width - 2; // inner width (excluding | borders)
    if (w < 6) return [];

    // Status icon (animated spinner for running)
    const icon = this.status === "running"
      ? SPINNER_FRAMES[this.spinFrame % SPINNER_FRAMES.length]
      : this.status === "complete" ? "✓"
      : this.status === "blocked" ? "⚠"
      : this.status === "error" ? "✗" : "○";

    const statusTheme = this.status === "running" ? "accent"
      : this.status === "complete" ? "success"
      : this.status === "blocked" ? "warning"
      : this.status === "error" ? "error" : "dim";

    const nameColor = this.status === "pending" ? "dim" : "accent";
    const displayRole = this.cardRole || this.modelRole;

    // Build border helpers using theme — accent borders when selected
    const bordColor = selected ? "accent" : "dim";
    const bord = (s: string) => theme.fg(bordColor, s);
    const top = bord("┌" + "─".repeat(w) + "┐");
    const bot = bord("└" + "─".repeat(w) + "┘");

    // Border helper: uses visibleWidth() on styled content for correct padding
    const border = (content: string) => {
      const contentVis = visibleWidth(content);
      const pad = " ".repeat(Math.max(0, w - contentVis));
      return bord("│") + content + pad + bord("│");
    };

    // Header: icon + label (prefer card.label, else strip prefix from name)
    // When in a loop, reserve space for right-aligned iteration badge: " ↻ X/Y"
    const loopBadge = this.loopIteration > 0 ? `↻ ${this.loopIteration}/${this.loopMax}` : "";
    const badgeVisWidth = loopBadge ? visibleWidth(loopBadge) : 0;
    const badgeReserve = badgeVisWidth ? badgeVisWidth + 2 : 0; // +2 for surrounding spaces
    const displayName = this.label || this.agentName;
    const maxNameLen = w - 3 - badgeReserve; // 3 = space + icon + space before name
    const name = displayName.length > maxNameLen
      ? displayName.slice(0, Math.max(1, maxNameLen - 1)) + "…" : displayName;
    const iconStr = theme.fg(statusTheme, icon);
    const nameStr = theme.fg(nameColor, theme.bold(name));

    // Body lines
    let raw0 = "";
    // Rolling window: raw tool call strings (newest first), up to MAX_RECENT_TOOLS
    const rawTools: string[] = [];

    if (this.status === "pending" && this.blockedByNames.length > 0) {
      const depNames = this.blockedByNames;
      let depLine = `waiting: ${depNames.join(", ")}`;
      depLine = truncate(depLine, w - 2);
      raw0 = " " + depLine;
    } else {
      raw0 = truncate(sanitize(this.renderer.renderMetric(w - 1)), w - 1);
      for (let i = this.recentTools.length - 1; i >= 0; i--) {
        const t = this.recentTools[i];
        const prefix = i === this.recentTools.length - 1 ? "▸" : "·";
        rawTools.push(truncate(`  ${prefix} ${t.toolName} ${t.inputPreview}`, w - 1));
      }
    }

    // Pad to MAX_RECENT_TOOLS lines for consistent card height
    while (rawTools.length < MAX_RECENT_TOOLS) rawTools.push("");

    const bodyLine0 = " " + theme.fg("muted", raw0);
    const toolRendered = rawTools.map(raw => {
      const styled = raw ? " " + theme.fg("dim", raw) : "";
      return border(styled);
    });

    // Role subtitle line — show tokens when complete, role when running/pending
    let roleText = "";
    if ((this.status === "complete" || this.status === "error" || this.status === "blocked") && (this.tokens.input > 0 || this.tokens.output > 0)) {
      const tokenInfo = `↑${formatTokens(this.tokens.input)} ↓${formatTokens(this.tokens.output)}`;
      const durationSec = (this.duration / 1000).toFixed(1) + "s";
      roleText = truncate(`  ${tokenInfo} · ${durationSec}`, w - 1);
    } else if (displayRole) {
      roleText = truncate("  " + displayRole, w - 1);
    }
    const roleLine = roleText
      ? border(" " + theme.fg("dim", roleText))
      : border("");

    // Build header content with optional right-aligned iteration badge
    const headerLeft = " " + iconStr + " " + nameStr;
    const badgeStr = loopBadge ? theme.fg("accent", loopBadge) + " " : "";
    const headerContent = loopBadge
      ? (() => {
          const leftVis = visibleWidth(headerLeft);
          const rightVis = visibleWidth(badgeStr);
          const gap = Math.max(1, w - leftVis - rightVis);
          return headerLeft + " ".repeat(gap) + badgeStr;
        })()
      : headerLeft;

    const result = [
      top,
      border(headerContent),
      roleLine,
      border(bodyLine0),
    ];
    result.push(...toolRendered, bot);

    // Debug assertion: verify all lines have exactly `width` visible characters
    if (process.env.PI_DEBUG_CARDS === "1") {
      for (let i = 0; i < result.length; i++) {
        const vw = visibleWidth(result[i]);
        if (vw !== width) {
          console.error(`AgentCard line ${i} width mismatch: ${vw} !== ${width} (agent: ${this.agentName})`);
        }
      }
    }

    return result;
  }

  invalidate(): void {}
}
