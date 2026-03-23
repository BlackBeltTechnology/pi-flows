import type { AgentCardRenderer } from "./types.js";
import type { AgentResult } from "../flow-engine/types.js";

/** "files" metric renderer — tracks files read/written + word count. */
export class FilesCard implements AgentCardRenderer {
  private filesRead = 0;
  private filesWritten = 0;
  private wordCount = 0;

  onToolCall(toolName: string, _input: any): void {
    const lower = toolName.toLowerCase();
    if (lower === "read") {
      this.filesRead++;
    } else if (lower === "write" || lower === "edit") {
      this.filesWritten++;
    }
  }

  onToolResult(toolName: string, output: any): void {
    // Count words from read results for insight into volume
    const lower = toolName.toLowerCase();
    if (lower === "read" && typeof output === "string") {
      this.wordCount += output.split(/\s+/).filter(Boolean).length;
    }
  }

  onComplete(_result: AgentResult): void {}

  renderMetric(_width: number): string {
    const parts: string[] = [];
    if (this.filesRead > 0) parts.push(`${this.filesRead} read`);
    if (this.filesWritten > 0) parts.push(`${this.filesWritten} written`);
    if (this.wordCount > 0) {
      const kw = this.wordCount >= 1000
        ? `${(this.wordCount / 1000).toFixed(1)}k`
        : `${this.wordCount}`;
      parts.push(`${kw} words`);
    }
    return parts.length > 0 ? parts.join(" · ") : "";
  }
}
