import type { AgentCardRenderer } from "./types.js";
import type { AgentResult } from "../flow-engine/types.js";

/** "tests" metric renderer — tracks test pass/fail counts. */
export class TestsCard implements AgentCardRenderer {
  private passed = 0;
  private failed = 0;
  private bashCalls = 0;

  onToolCall(toolName: string, _input: any): void {
    const lower = toolName.toLowerCase();
    if (lower === "bash") {
      this.bashCalls++;
    }
  }

  onToolResult(toolName: string, output: any): void {
    const lower = toolName.toLowerCase();
    if (lower !== "bash" || typeof output !== "string") return;

    // Parse common test runner output patterns
    // Jest/Vitest: "Tests: X passed, Y failed"
    const jestMatch = output.match(/Tests:\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/i);
    if (jestMatch) {
      this.passed += parseInt(jestMatch[1], 10) || 0;
      this.failed += parseInt(jestMatch[2] || "0", 10) || 0;
      return;
    }

    // pytest: "X passed, Y failed" or "X passed"
    const pytestMatch = output.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/i);
    if (pytestMatch) {
      this.passed += parseInt(pytestMatch[1], 10) || 0;
      this.failed += parseInt(pytestMatch[2] || "0", 10) || 0;
      return;
    }

    // Generic: count lines with common pass/fail markers
    const lines = output.split("\n");
    for (const line of lines) {
      if (/^\s*[✓✔PASS]\s/i.test(line)) this.passed++;
      if (/^\s*[✗✘FAIL]\s/i.test(line)) this.failed++;
    }
  }

  onComplete(_result: AgentResult): void {}

  renderMetric(_width: number): string {
    const parts: string[] = [];
    if (this.passed > 0) parts.push(`✓ ${this.passed}`);
    if (this.failed > 0) parts.push(`✗ ${this.failed}`);
    if (parts.length === 0 && this.bashCalls > 0) {
      return `${this.bashCalls} commands`;
    }
    return parts.join(" · ");
  }
}
