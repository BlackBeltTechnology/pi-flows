import type { AgentCardRenderer } from "./types.js";

/** Default metric renderer — no metric line (just tool call tracking via AgentCard). */
export class DefaultCard implements AgentCardRenderer {
  onToolCall(): void {}
  onToolResult(): void {}
  onComplete(): void {}
  renderMetric(_width: number): string { return ""; }
}
